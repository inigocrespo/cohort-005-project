import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { NotificationKind, UserRole } from "~/db/schema";
import {
  getInbox,
  notifyRefundRequestRaised,
  notifySeatClaimed,
} from "./notifications.server";
import { approveRefundRequest, raiseRefundRequest } from "./refunds.server";

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

describe("Refund Request raised", () => {
  const REASON = "It was not what I expected at all.";

  function addPlatformAdmin(name: string) {
    const person = addPerson(name);
    setRole(person.id, UserRole.Admin);
    return person;
  }

  function setRole(userId: number, role: UserRole) {
    db.update(schema.users)
      .set({ role })
      .where(eq(schema.users.id, userId))
      .run();
  }

  function buyForSelf(userId: number, daysAgo = 0) {
    const purchasedAt = new Date(NOW);
    purchasedAt.setDate(purchasedAt.getDate() - daysAgo);
    const purchase = db
      .insert(schema.purchases)
      .values({
        userId,
        courseId: base.course.id,
        amountPaid: 7900,
        createdAt: purchasedAt.toISOString(),
      })
      .returning()
      .get();
    db.insert(schema.enrollments)
      .values({ userId, courseId: base.course.id })
      .run();
    return purchase;
  }

  // Mirrors the route: record only once the Refund Request has been raised.
  function raise(purchaseId: number, buyerId: number) {
    const result = raiseRefundRequest(db, purchaseId, buyerId, REASON, NOW);
    if (result.ok) notifyRefundRequestRaised(db, result.refundRequestId);
    return result;
  }

  it("gives a Platform Admin one unread Notification linking to the Refund Requests page, naming the buyer and the course", () => {
    const pat = addPlatformAdmin("Pat");
    const liam = addPerson("Liam");

    raise(buyForSelf(liam.id).id, liam.id);

    const inbox = getInbox(db, pat.id);
    expect(inbox.unreadCount).toBe(1);
    expect(inbox.notifications).toEqual([
      expect.objectContaining({
        kind: NotificationKind.RefundRequestRaised,
        headline: "Liam raised a Refund Request for Test Course",
        link: "/admin/refunds",
        isRead: false,
      }),
    ]);
  });

  it("gives every Platform Admin their own Notification", () => {
    const pat = addPlatformAdmin("Pat");
    const quinn = addPlatformAdmin("Quinn");
    const liam = addPerson("Liam");

    raise(buyForSelf(liam.id).id, liam.id);

    expect(getInbox(db, pat.id).unreadCount).toBe(1);
    expect(getInbox(db, quinn.id).unreadCount).toBe(1);
  });

  it("tells nobody else: not the buyer, nor Students or Instructors", () => {
    addPlatformAdmin("Pat");
    const liam = addPerson("Liam");

    raise(buyForSelf(liam.id).id, liam.id);

    expect(getInbox(db, liam.id).unreadCount).toBe(0);
    expect(getInbox(db, base.user.id).unreadCount).toBe(0);
    expect(getInbox(db, base.instructor.id).unreadCount).toBe(0);
  });

  it("doesn't tell a Platform Admin about a Refund Request on their own Purchase", () => {
    const pat = addPlatformAdmin("Pat");
    const quinn = addPlatformAdmin("Quinn");

    raise(buyForSelf(pat.id).id, pat.id);

    expect(getInbox(db, pat.id).unreadCount).toBe(0);
    expect(getInbox(db, quinn.id).notifications).toEqual([
      expect.objectContaining({
        headline: "Pat raised a Refund Request for Test Course",
      }),
    ]);
  });

  it("gives no Notification for earlier Refund Requests to someone promoted to Platform Admin afterwards", () => {
    const liam = addPerson("Liam");
    const ana = addPerson("Ana");
    raise(buyForSelf(liam.id).id, liam.id);

    setRole(ana.id, UserRole.Admin);

    expect(getInbox(db, ana.id).notifications).toEqual([]);
  });

  it("lets a demoted Platform Admin keep the Notifications they already had", () => {
    const pat = addPlatformAdmin("Pat");
    const liam = addPerson("Liam");
    raise(buyForSelf(liam.id).id, liam.id);

    setRole(pat.id, UserRole.Student);

    expect(getInbox(db, pat.id).unreadCount).toBe(1);
  });

  describe("records nothing when the Refund Request fails to raise", () => {
    let pat: typeof schema.users.$inferSelect;
    let liam: typeof schema.users.$inferSelect;

    beforeEach(() => {
      pat = addPlatformAdmin("Pat");
      liam = addPerson("Liam");
    });

    it("because the person isn't the buyer", () => {
      const purchase = buyForSelf(liam.id);

      expect(raise(purchase.id, addPerson("Ana").id).ok).toBe(false);
      expect(getInbox(db, pat.id).unreadCount).toBe(0);
    });

    it("because one is already open", () => {
      const purchase = buyForSelf(liam.id);
      raise(purchase.id, liam.id);

      expect(raise(purchase.id, liam.id).ok).toBe(false);
      expect(getInbox(db, pat.id).unreadCount).toBe(1);
    });

    it("because the Purchase is already refunded", () => {
      const purchase = buyForSelf(liam.id);
      const first = raise(purchase.id, liam.id);
      if (!first.ok) throw new Error(first.error);
      approveRefundRequest(db, first.refundRequestId, pat.id, null, NOW);

      expect(raise(purchase.id, liam.id).ok).toBe(false);
      expect(getInbox(db, pat.id).unreadCount).toBe(1);
    });

    it("because it breaks a rule", () => {
      const purchase = buyForSelf(liam.id, 30);

      expect(raise(purchase.id, liam.id).ok).toBe(false);
      expect(getInbox(db, pat.id).unreadCount).toBe(0);
    });

    it("because there is no such Refund Request", () => {
      notifyRefundRequestRaised(db, 999);

      expect(getInbox(db, pat.id).unreadCount).toBe(0);
    });
  });

  it("never quotes the Refund Request reason in the headline", () => {
    const pat = addPlatformAdmin("Pat");
    const liam = addPerson("Liam");

    raise(buyForSelf(liam.id).id, liam.id);

    expect(getInbox(db, pat.id).notifications[0].headline).not.toContain(
      "not what I expected"
    );
  });

  it("keeps its headline and its read state after the Refund Request is decided and the buyer renamed", () => {
    const pat = addPlatformAdmin("Pat");
    const quinn = addPlatformAdmin("Quinn");
    const liam = addPerson("Liam");
    const raised = raise(buyForSelf(liam.id).id, liam.id);
    if (!raised.ok) throw new Error(raised.error);

    approveRefundRequest(db, raised.refundRequestId, quinn.id, null, NOW);
    db.update(schema.users)
      .set({ name: "William" })
      .where(eq(schema.users.id, liam.id))
      .run();

    expect(getInbox(db, pat.id).notifications).toEqual([
      expect.objectContaining({
        headline: "Liam raised a Refund Request for Test Course",
        link: "/admin/refunds",
        isRead: false,
      }),
    ]);
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
