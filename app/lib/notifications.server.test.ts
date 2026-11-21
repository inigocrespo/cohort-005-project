import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { NotificationKind, RefundStatus, UserRole } from "~/db/schema";
import {
  getInbox,
  notifyRefundRequestDecided,
  notifySeatClaimed,
} from "./notifications.server";
import {
  approveRefundRequest,
  declineRefundRequest,
} from "./refunds.server";

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

describe("Refund Request decided", () => {
  let platformAdmin: typeof schema.users.$inferSelect;
  let buyer: typeof schema.users.$inferSelect;

  beforeEach(() => {
    platformAdmin = addPerson("Pam");
    db.update(schema.users)
      .set({ role: UserRole.Admin })
      .where(eq(schema.users.id, platformAdmin.id))
      .run();
    buyer = addPerson("Bea");
  });

  function buyIndividually(userId: number) {
    return db
      .insert(schema.purchases)
      .values({ userId, courseId: base.course.id, amountPaid: 7900 })
      .returning()
      .get();
  }

  function raise(purchaseId: number) {
    return db
      .insert(schema.refunds)
      .values({
        purchaseId,
        status: RefundStatus.Open,
        reason: "Secret reason nobody else should read",
        requestedAt: NOW.toISOString(),
      })
      .returning()
      .get().id;
  }

  // As the approve and decline actions do: record only once the decision
  // has succeeded.
  function approve(refundRequestId: number, deciderId = platformAdmin.id) {
    const result = approveRefundRequest(
      db,
      refundRequestId,
      deciderId,
      "Private approval note",
      NOW
    );
    if (result.ok) notifyRefundRequestDecided(db, refundRequestId);
    return result;
  }

  function decline(refundRequestId: number, deciderId = platformAdmin.id) {
    const result = declineRefundRequest(
      db,
      refundRequestId,
      deciderId,
      "Private decline note",
      NOW
    );
    if (result.ok) notifyRefundRequestDecided(db, refundRequestId);
    return result;
  }

  it("gives the buyer of an Individual Purchase one unread Notification saying it was approved, linking to Settings", () => {
    const refundRequestId = raise(buyIndividually(buyer.id).id);

    approve(refundRequestId);

    const inbox = getInbox(db, buyer.id);
    expect(inbox.unreadCount).toBe(1);
    expect(inbox.notifications).toEqual([
      expect.objectContaining({
        kind: NotificationKind.RefundRequestDecided,
        headline: "Your refund request for Test Course was approved",
        link: "/settings",
        isRead: false,
      }),
    ]);
  });

  it("gives the buyer one unread Notification saying it was declined", () => {
    const refundRequestId = raise(buyIndividually(buyer.id).id);

    decline(refundRequestId);

    const inbox = getInbox(db, buyer.id);
    expect(inbox.unreadCount).toBe(1);
    expect(inbox.notifications).toEqual([
      expect.objectContaining({
        kind: NotificationKind.RefundRequestDecided,
        headline: "Your refund request for Test Course was declined",
        link: "/settings",
        isRead: false,
      }),
    ]);
  });

  it("gives the Team Admin of a Team Licence a Notification linking to the Team page", () => {
    const [seat] = buySeats(teamAdmin.id, 2);
    const refundRequestId = raise(seat.purchaseId!);

    approve(refundRequestId);

    expect(getInbox(db, teamAdmin.id).notifications).toEqual([
      expect.objectContaining({
        headline: "Your refund request for Test Course was approved",
        link: "/team",
      }),
    ]);
  });

  it("tells nobody when the buyer is the Platform Admin deciding their own Refund Request", () => {
    const refundRequestId = raise(buyIndividually(platformAdmin.id).id);

    decline(refundRequestId, platformAdmin.id);

    expect(getInbox(db, platformAdmin.id).unreadCount).toBe(0);
  });

  it("records nothing for a Refund Request that is still open", () => {
    const refundRequestId = raise(buyIndividually(buyer.id).id);

    notifyRefundRequestDecided(db, refundRequestId);

    expect(getInbox(db, buyer.id).unreadCount).toBe(0);
  });

  it("tells no Student on a Claimed Seat of the Team Licence", () => {
    const [seat] = buySeats(teamAdmin.id, 2);
    const ana = addPerson("Ana");
    claimSeat(seat.id, ana.id);
    const refundRequestId = raise(seat.purchaseId!);

    decline(refundRequestId);

    expect(getInbox(db, ana.id).notifications).toEqual([]);
    expect(
      getInbox(db, teamAdmin.id).notifications.filter(
        (n) => n.kind === NotificationKind.RefundRequestDecided
      )
    ).toHaveLength(1);
  });

  it("records nothing when an approval is refused because a Seat is claimed", () => {
    const [seat] = buySeats(teamAdmin.id, 2);
    claimSeat(seat.id, addPerson("Ana").id);
    const refundRequestId = raise(seat.purchaseId!);

    expect(approve(refundRequestId).ok).toBe(false);
    notifyRefundRequestDecided(db, refundRequestId);

    expect(
      getInbox(db, teamAdmin.id).notifications.map((n) => n.kind)
    ).not.toContain(NotificationKind.RefundRequestDecided);
  });

  it("records nothing more when a second Platform Admin tries to decide it again", () => {
    const refundRequestId = raise(buyIndividually(buyer.id).id);
    const secondAdmin = addPerson("Sam");

    approve(refundRequestId);
    expect(decline(refundRequestId, secondAdmin.id).ok).toBe(false);

    expect(getInbox(db, buyer.id).notifications).toEqual([
      expect.objectContaining({
        headline: "Your refund request for Test Course was approved",
      }),
    ]);
  });

  it("never quotes the Refund Request reason or the decision note", () => {
    approve(raise(buyIndividually(buyer.id).id));
    decline(raise(buyIndividually(buyer.id).id));

    const headlines = getInbox(db, buyer.id).notifications.map(
      (n) => n.headline
    );
    expect(headlines).toHaveLength(2);
    for (const headline of headlines) {
      expect(headline).not.toContain("Secret reason");
      expect(headline).not.toContain("Private");
    }
  });

  it("keeps its headline after the course is renamed", () => {
    approve(raise(buyIndividually(buyer.id).id));

    db.update(schema.courses)
      .set({ title: "Renamed Course" })
      .where(eq(schema.courses.id, base.course.id))
      .run();

    expect(getInbox(db, buyer.id).notifications[0].headline).toBe(
      "Your refund request for Test Course was approved"
    );
  });

  it("leaves other Platform Admins' Notifications as they were", () => {
    const otherAdmin = addPerson("Otto");
    // Their "Refund Request raised" Notifications, one read and one not.
    db.insert(schema.notifications)
      .values([
        {
          recipientId: otherAdmin.id,
          kind: NotificationKind.RefundRequestRaised,
          headline: "Bea requested a refund for Test Course",
          link: "/admin/refunds",
          readAt: NOW.toISOString(),
        },
        {
          recipientId: otherAdmin.id,
          kind: NotificationKind.RefundRequestRaised,
          headline: "Bea requested a refund for Test Course",
          link: "/admin/refunds",
        },
      ])
      .run();
    const before = getInbox(db, otherAdmin.id);

    approve(raise(buyIndividually(buyer.id).id));

    expect(getInbox(db, otherAdmin.id)).toEqual(before);
    expect(before.unreadCount).toBe(1);
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
