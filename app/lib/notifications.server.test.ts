import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { NotificationKind, RefundStatus, UserRole } from "~/db/schema";
import {
  listRefundRequestsForReview,
  raiseRefundRequest,
} from "./refunds.server";
import {
  getInbox,
  markAllRead,
  markRead,
  markUnread,
  notifySeatClaimed,
} from "./notifications.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let teamAdmin: typeof schema.users.$inferSelect;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  teamAdmin = addPerson("Tess");
});

function addPerson(name: string) {
  return db
    .insert(schema.users)
    .values({
      name,
      email: `${name.toLowerCase()}@example.com`,
      role: UserRole.Student,
    })
    .returning()
    .get();
}

function buySeats(userId: number, seats: number) {
  const team = db.insert(schema.teams).values({}).returning().get();
  const purchase = db
    .insert(schema.purchases)
    .values({ userId, courseId: base.course.id, amountPaid: 7900 * seats })
    .returning()
    .get();
  return Array.from({ length: seats }, (_, i) =>
    db
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: base.course.id,
        code: `SEAT-${purchase.id}-${i}`,
        purchaseId: purchase.id,
      })
      .returning()
      .get()
  );
}

function claimSeat(seatId: number, userId: number) {
  db.update(schema.coupons)
    .set({ redeemedByUserId: userId, redeemedAt: NOW.toISOString() })
    .where(eq(schema.coupons.id, seatId))
    .run();
  notifySeatClaimed(db, seatId);
}

describe("Seat claimed", () => {
  it("gives the Team Admin one unread Notification linking to the Team page, naming the Student and the course", () => {
    const [seat] = buySeats(teamAdmin.id, 3);
    const ana = addPerson("Ana");

    claimSeat(seat.id, ana.id);

    const inbox = getInbox(db, teamAdmin.id);
    expect(inbox.unreadCount).toBe(1);
    expect(inbox.notifications).toEqual([
      expect.objectContaining({
        kind: NotificationKind.SeatClaimed,
        headline: "Ana claimed a Seat on Test Course",
        link: "/team",
        isRead: false,
      }),
    ]);
  });

  it("gives the Team Admin their own Notification for each claim, not grouped", () => {
    const [first, second] = buySeats(teamAdmin.id, 3);

    claimSeat(first.id, addPerson("Ana").id);
    claimSeat(second.id, addPerson("Ben").id);

    const inbox = getInbox(db, teamAdmin.id);
    expect(inbox.unreadCount).toBe(2);
    expect(inbox.notifications.map((n) => n.headline).sort()).toEqual([
      "Ana claimed a Seat on Test Course",
      "Ben claimed a Seat on Test Course",
    ]);
  });

  it("tells nobody when the Team Admin claims a Seat on their own Team Licence", () => {
    const [seat] = buySeats(teamAdmin.id, 2);

    claimSeat(seat.id, teamAdmin.id);

    expect(getInbox(db, teamAdmin.id)).toMatchObject({
      notifications: [],
      unreadCount: 0,
    });
  });

  it("tells only the Team Admin, not the Student who claimed", () => {
    const [seat] = buySeats(teamAdmin.id, 2);
    const ana = addPerson("Ana");

    claimSeat(seat.id, ana.id);

    expect(getInbox(db, ana.id).notifications).toEqual([]);
  });

  it("records nothing for a Seat nobody has claimed", () => {
    const [seat] = buySeats(teamAdmin.id, 1);

    notifySeatClaimed(db, seat.id);

    expect(getInbox(db, teamAdmin.id).unreadCount).toBe(0);
  });

  it("keeps its headline after the Student is renamed", () => {
    const [seat] = buySeats(teamAdmin.id, 1);
    const ana = addPerson("Ana");
    claimSeat(seat.id, ana.id);

    db.update(schema.users)
      .set({ name: "Anastasia" })
      .where(eq(schema.users.id, ana.id))
      .run();

    expect(getInbox(db, teamAdmin.id).notifications[0].headline).toBe(
      "Ana claimed a Seat on Test Course"
    );
  });
});

describe("Inbox", () => {
  let studentCount = 0;

  function claimSeats(count: number) {
    const seats = buySeats(teamAdmin.id, count);
    seats.forEach((seat) =>
      claimSeat(seat.id, addPerson(`S${++studentCount}`).id)
    );
  }

  beforeEach(() => {
    studentCount = 0;
  });

  it("lists the newest 20 Notifications, newest first, leaving older ones out", () => {
    claimSeats(25);

    const headlines = getInbox(db, teamAdmin.id).notifications.map(
      (n) => n.headline
    );

    expect(headlines).toHaveLength(20);
    expect(headlines[0]).toBe("S25 claimed a Seat on Test Course");
    expect(headlines[19]).toBe("S6 claimed a Seat on Test Course");
  });

  it("counts every unread Notification, not just the newest 20", () => {
    claimSeats(25);

    expect(getInbox(db, teamAdmin.id).unreadCount).toBe(25);
  });

  it("shows no badge when nothing is unread", () => {
    expect(getInbox(db, teamAdmin.id)).toEqual({
      notifications: [],
      unreadCount: 0,
      badgeLabel: null,
    });
  });

  it("shows the exact unread count on the badge up to 99", () => {
    claimSeats(1);
    expect(getInbox(db, teamAdmin.id).badgeLabel).toBe("1");

    claimSeats(98);
    expect(getInbox(db, teamAdmin.id).badgeLabel).toBe("99");
  });

  it('shows "99+" on the badge above 99', () => {
    claimSeats(100);

    expect(getInbox(db, teamAdmin.id).badgeLabel).toBe("99+");
  });

  it("holds only the person's own Notifications", () => {
    const otherTeamAdmin = addPerson("Otto");
    const [mine] = buySeats(teamAdmin.id, 1);
    const [theirs] = buySeats(otherTeamAdmin.id, 1);

    claimSeat(mine.id, addPerson("Ana").id);
    claimSeat(theirs.id, addPerson("Ben").id);

    const inbox = getInbox(db, teamAdmin.id);
    expect(inbox.unreadCount).toBe(1);
    expect(inbox.notifications.map((n) => n.headline)).toEqual([
      "Ana claimed a Seat on Test Course",
    ]);
  });
});

describe("Read state", () => {
  function notifyTeamAdmin(studentName: string) {
    const [seat] = buySeats(teamAdmin.id, 1);
    claimSeat(seat.id, addPerson(studentName).id);
    return getInbox(db, teamAdmin.id).notifications[0];
  }

  it("marks a Notification read, taking it off the unread count", () => {
    const notification = notifyTeamAdmin("Ana");

    markRead(db, teamAdmin.id, notification.id);

    const inbox = getInbox(db, teamAdmin.id);
    expect(inbox.unreadCount).toBe(0);
    expect(inbox.badgeLabel).toBeNull();
    expect(inbox.notifications[0]).toMatchObject({
      id: notification.id,
      isRead: true,
    });
  });

  it("changes nothing when asked to mark someone else's Notification", () => {
    const notification = notifyTeamAdmin("Ana");
    const stranger = addPerson("Sam");

    markRead(db, stranger.id, notification.id);

    expect(getInbox(db, teamAdmin.id).unreadCount).toBe(1);
  });

  it("marks a read Notification unread again, putting it back on the count", () => {
    const notification = notifyTeamAdmin("Ana");
    markRead(db, teamAdmin.id, notification.id);

    markUnread(db, teamAdmin.id, notification.id);

    const inbox = getInbox(db, teamAdmin.id);
    expect(inbox.unreadCount).toBe(1);
    expect(inbox.notifications[0].isRead).toBe(false);
  });

  it("won't mark someone else's Notification unread", () => {
    const notification = notifyTeamAdmin("Ana");
    markRead(db, teamAdmin.id, notification.id);

    markUnread(db, addPerson("Sam").id, notification.id);

    expect(getInbox(db, teamAdmin.id).unreadCount).toBe(0);
  });

  it("marks all read, including Notifications beyond the newest 20", () => {
    const seats = buySeats(teamAdmin.id, 25);
    seats.forEach((seat, i) => claimSeat(seat.id, addPerson(`S${i}`).id));

    markAllRead(db, teamAdmin.id);

    // The unread count spans every Notification, not just the listed 20.
    expect(getInbox(db, teamAdmin.id).unreadCount).toBe(0);
  });

  it("marks all read for only the given person", () => {
    notifyTeamAdmin("Ana");
    const otherTeamAdmin = addPerson("Otto");
    const [theirs] = buySeats(otherTeamAdmin.id, 1);
    claimSeat(theirs.id, addPerson("Ben").id);

    markAllRead(db, teamAdmin.id);

    expect(getInbox(db, teamAdmin.id).unreadCount).toBe(0);
    expect(getInbox(db, otherTeamAdmin.id).unreadCount).toBe(1);
  });

  it("leaves another person's copy of the same event unread", () => {
    // Some events tell several people at once, each getting their own copy.
    const [mine, theirs] = [teamAdmin, addPerson("Otto")].map((recipient) =>
      db
        .insert(schema.notifications)
        .values({
          recipientId: recipient.id,
          kind: NotificationKind.RefundRequestRaised,
          headline: "Ana asked for a refund on Test Course",
          link: "/admin/refunds",
        })
        .returning()
        .get()
    );

    markRead(db, teamAdmin.id, mine.id);

    expect(getInbox(db, teamAdmin.id).unreadCount).toBe(0);
    expect(getInbox(db, theirs.recipientId).unreadCount).toBe(1);
  });

  it("leaves the Refund Requests work queue alone when marking all read", () => {
    const now = new Date();
    notifyTeamAdmin("Ana");
    const [unclaimed] = buySeats(teamAdmin.id, 2);
    const raised = raiseRefundRequest(
      db,
      unclaimed.purchaseId!,
      teamAdmin.id,
      "We no longer need these seats.",
      now
    );
    if (!raised.ok) throw new Error(raised.error);

    markAllRead(db, teamAdmin.id);

    expect(
      listRefundRequestsForReview(db, RefundStatus.Open, now).map((r) => r.id)
    ).toEqual([raised.refundRequestId]);
  });
});
