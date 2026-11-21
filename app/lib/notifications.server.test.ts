import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { NotificationKind, RefundStatus, UserRole } from "~/db/schema";
import {
  getInbox,
  markAllRead,
  markRead,
  markUnread,
  notifyCommentPosted,
  notifyRefundRequestDecided,
  notifyRefundRequestRaised,
  notifySeatClaimed,
} from "./notifications.server";
import {
  approveRefundRequest,
  declineRefundRequest,
  listRefundRequestsForReview,
  raiseRefundRequest,
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
      .values({
        userId,
        courseId: base.course.id,
        amountPaid: 7900,
        createdAt: NOW.toISOString(),
      })
      .returning()
      .get();
  }

  function teamLicenceOf(seat: typeof schema.coupons.$inferSelect) {
    if (seat.purchaseId === null) throw new Error("Seat has no Team Licence");
    return seat.purchaseId;
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
        headline: "Your Refund Request for Test Course was approved",
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
        headline: "Your Refund Request for Test Course was declined",
        link: "/settings",
        isRead: false,
      }),
    ]);
  });

  it("gives the Team Admin of a Team Licence a Notification linking to the Team page", () => {
    const [seat] = buySeats(teamAdmin.id, 2);
    const refundRequestId = raise(teamLicenceOf(seat));

    approve(refundRequestId);

    expect(getInbox(db, teamAdmin.id).notifications).toEqual([
      expect.objectContaining({
        headline: "Your Refund Request for Test Course was approved",
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
    const refundRequestId = raise(teamLicenceOf(seat));

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
    const refundRequestId = raise(teamLicenceOf(seat));

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
        headline: "Your Refund Request for Test Course was approved",
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
      "Your Refund Request for Test Course was approved"
    );
  });

  it("leaves other Platform Admins' Refund Request raised Notifications as they were", () => {
    const otherAdmin = addPerson("Otto");
    db.update(schema.users)
      .set({ role: UserRole.Admin })
      .where(eq(schema.users.id, otherAdmin.id))
      .run();
    const raised = raiseRefundRequest(
      db,
      buyIndividually(buyer.id).id,
      buyer.id,
      "Secret reason nobody else should read",
      NOW
    );
    if (!raised.ok) throw new Error(raised.error);
    notifyRefundRequestRaised(db, raised.refundRequestId);
    const before = getInbox(db, otherAdmin.id);

    approve(raised.refundRequestId);

    expect(before.unreadCount).toBe(1);
    expect(getInbox(db, otherAdmin.id)).toEqual(before);
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

  function addPlatformAdmin(name: string) {
    const person = addPerson(name);
    db.update(schema.users)
      .set({ role: UserRole.Admin })
      .where(eq(schema.users.id, person.id))
      .run();
    return person;
  }

  // A buyer raises a Refund Request, telling every Platform Admin.
  function raiseRefundRequestFor(buyerName: string) {
    const buyer = addPerson(buyerName);
    const purchase = db
      .insert(schema.purchases)
      .values({
        userId: buyer.id,
        courseId: base.course.id,
        amountPaid: 7900,
        createdAt: NOW.toISOString(),
      })
      .returning()
      .get();
    const raised = raiseRefundRequest(
      db,
      purchase.id,
      buyer.id,
      "It was not what I expected at all.",
      NOW
    );
    if (!raised.ok) throw new Error(raised.error);
    notifyRefundRequestRaised(db, raised.refundRequestId);
    return raised.refundRequestId;
  }

  it("leaves another person's copy of the same event unread", () => {
    const pat = addPlatformAdmin("Pat");
    const ada = addPlatformAdmin("Ada");
    raiseRefundRequestFor("Liam");

    markRead(db, pat.id, getInbox(db, pat.id).notifications[0].id);

    expect(getInbox(db, pat.id).unreadCount).toBe(0);
    expect(getInbox(db, ada.id).unreadCount).toBe(1);
  });

  it("leaves the Refund Requests work queue alone when marking all read", () => {
    const pat = addPlatformAdmin("Pat");
    const refundRequestId = raiseRefundRequestFor("Liam");

    markAllRead(db, pat.id);

    expect(getInbox(db, pat.id).unreadCount).toBe(0);
    expect(
      listRefundRequestsForReview(db, RefundStatus.Open, NOW).map((r) => r.id)
    ).toEqual([refundRequestId]);
  });
});

describe("New Question", () => {
  let lesson: typeof schema.lessons.$inferSelect;

  beforeEach(() => {
    const mod = db
      .insert(schema.modules)
      .values({ courseId: base.course.id, title: "Basics", position: 1 })
      .returning()
      .get();
    lesson = db
      .insert(schema.lessons)
      .values({ moduleId: mod.id, title: "Lesson 3: Loops", position: 1 })
      .returning()
      .get();
  });

  function postComment(userId: number, body = "How do I break out early?") {
    const comment = db
      .insert(schema.comments)
      .values({ userId, lessonId: lesson.id, body })
      .returning()
      .get();
    notifyCommentPosted(db, comment.id);
    return comment;
  }

  it("gives the course's Instructor one unread Notification linking to the Instructor Questions page, naming the Student and the lesson", () => {
    const ana = addPerson("Ana");

    postComment(ana.id);

    const inbox = getInbox(db, base.instructor.id);
    expect(inbox.unreadCount).toBe(1);
    expect(inbox.notifications).toEqual([
      expect.objectContaining({
        kind: NotificationKind.NewQuestion,
        headline: "Ana asked a Question on Lesson 3: Loops",
        link: "/instructor/questions",
        isRead: false,
      }),
    ]);
  });

  it("tells no Platform Admin and not the Student who asked", () => {
    const admin = addPerson("Ada");
    db.update(schema.users)
      .set({ role: UserRole.Admin })
      .where(eq(schema.users.id, admin.id))
      .run();
    const ana = addPerson("Ana");

    postComment(ana.id);

    expect(getInbox(db, admin.id).notifications).toEqual([]);
    expect(getInbox(db, ana.id).notifications).toEqual([]);
  });

  it("tells nobody when the course's Instructor posts a top-level comment", () => {
    postComment(base.instructor.id);

    expect(getInbox(db, base.instructor.id).notifications).toEqual([]);
  });

  it("tells nobody when a Platform Admin posts a top-level comment", () => {
    const admin = addPerson("Ada");
    db.update(schema.users)
      .set({ role: UserRole.Admin })
      .where(eq(schema.users.id, admin.id))
      .run();

    postComment(admin.id);

    expect(getInbox(db, base.instructor.id).notifications).toEqual([]);
    expect(getInbox(db, admin.id).notifications).toEqual([]);
  });

  it("records nothing for a comment that doesn't exist", () => {
    notifyCommentPosted(db, 9999);

    expect(getInbox(db, base.instructor.id).unreadCount).toBe(0);
  });

  it("never quotes the comment body in the headline", () => {
    postComment(addPerson("Ana").id, "SECRET-BODY-TEXT");

    const [notification] = getInbox(db, base.instructor.id).notifications;
    expect(notification.headline).not.toContain("SECRET-BODY-TEXT");
  });

  it("keeps its headline after the Question is edited or soft-deleted", () => {
    const question = postComment(addPerson("Ana").id);

    db.update(schema.comments)
      .set({ body: "Edited", editedAt: NOW.toISOString() })
      .where(eq(schema.comments.id, question.id))
      .run();
    expect(getInbox(db, base.instructor.id).notifications[0].headline).toBe(
      "Ana asked a Question on Lesson 3: Loops"
    );

    db.update(schema.comments)
      .set({ deletedAt: NOW.toISOString() })
      .where(eq(schema.comments.id, question.id))
      .run();
    expect(getInbox(db, base.instructor.id).notifications[0].headline).toBe(
      "Ana asked a Question on Lesson 3: Loops"
    );
  });
});

describe("Reply", () => {
  let lesson: typeof schema.lessons.$inferSelect;
  let ana: typeof schema.users.$inferSelect;
  let question: typeof schema.comments.$inferSelect;

  beforeEach(() => {
    const mod = db
      .insert(schema.modules)
      .values({ courseId: base.course.id, title: "Basics", position: 1 })
      .returning()
      .get();
    lesson = db
      .insert(schema.lessons)
      .values({ moduleId: mod.id, title: "Lesson 3: Loops", position: 1 })
      .returning()
      .get();
    ana = addPerson("Ana");
    question = post(ana.id, null, "How do I break out early?");
  });

  function post(userId: number, parentId: number | null, body = "Use break.") {
    const comment = db
      .insert(schema.comments)
      .values({ userId, lessonId: lesson.id, parentId, body })
      .returning()
      .get();
    notifyCommentPosted(db, comment.id);
    return comment;
  }

  it("gives the Question's author one unread Notification linking to the reply on its lesson page, naming the replier and the lesson", () => {
    const ben = addPerson("Ben");

    const reply = post(ben.id, question.id);

    const inbox = getInbox(db, ana.id);
    expect(inbox.unreadCount).toBe(1);
    expect(inbox.notifications).toEqual([
      expect.objectContaining({
        kind: NotificationKind.Reply,
        headline: "Ben replied to your comment on Lesson 3: Loops",
        link: `/courses/test-course/lessons/${lesson.id}#comment-${reply.id}`,
        isRead: false,
      }),
    ]);
  });

  it("tells only the Question's author, not others who replied to it, nor the Instructor", () => {
    const ben = addPerson("Ben");
    const cara = addPerson("Cara");

    post(ben.id, question.id);
    post(cara.id, question.id);

    expect(
      getInbox(db, ana.id).notifications.map((n) => n.headline).sort()
    ).toEqual([
      "Ben replied to your comment on Lesson 3: Loops",
      "Cara replied to your comment on Lesson 3: Loops",
    ]);
    expect(getInbox(db, ben.id).notifications).toEqual([]);
    expect(getInbox(db, cara.id).notifications).toEqual([]);
    expect(
      getInbox(db, base.instructor.id).notifications.map((n) => n.kind)
    ).toEqual([NotificationKind.NewQuestion]);
  });

  it("tells the Question's author when the Instructor or a Platform Admin answers it, as from the Instructor Questions page", () => {
    const ada = addPerson("Ada");
    db.update(schema.users)
      .set({ role: UserRole.Admin })
      .where(eq(schema.users.id, ada.id))
      .run();

    post(base.instructor.id, question.id);
    post(ada.id, question.id);

    expect(
      getInbox(db, ana.id).notifications.map((n) => n.headline).sort()
    ).toEqual([
      "Ada replied to your comment on Lesson 3: Loops",
      "Test Instructor replied to your comment on Lesson 3: Loops",
    ]);
    expect(getInbox(db, ada.id).notifications).toEqual([]);
  });

  it("tells the Instructor when someone replies to their own top-level comment", () => {
    const announcement = post(base.instructor.id, null, "Heads up!");

    const reply = post(ana.id, announcement.id);

    expect(getInbox(db, base.instructor.id).notifications).toContainEqual(
      expect.objectContaining({
        kind: NotificationKind.Reply,
        headline: "Ana replied to your comment on Lesson 3: Loops",
        link: `/courses/test-course/lessons/${lesson.id}#comment-${reply.id}`,
      })
    );
  });

  it("gives the Question's author nothing when they reply to their own Question", () => {
    post(ana.id, question.id);

    expect(getInbox(db, ana.id).notifications).toEqual([]);
  });

  it("never quotes the reply or the Question in the headline", () => {
    post(addPerson("Ben").id, question.id, "SECRET-REPLY-TEXT");

    const [notification] = getInbox(db, ana.id).notifications;
    expect(notification.headline).not.toContain("SECRET-REPLY-TEXT");
    expect(notification.headline).not.toContain("break out early");
  });

  it("keeps its headline and link after the reply or the Question is edited or soft-deleted", () => {
    const reply = post(addPerson("Ben").id, question.id);
    const expected = expect.objectContaining({
      headline: "Ben replied to your comment on Lesson 3: Loops",
      link: `/courses/test-course/lessons/${lesson.id}#comment-${reply.id}`,
    });

    for (const comment of [reply, question]) {
      db.update(schema.comments)
        .set({ body: "Edited", editedAt: NOW.toISOString() })
        .where(eq(schema.comments.id, comment.id))
        .run();
      expect(getInbox(db, ana.id).notifications).toEqual([expected]);

      db.update(schema.comments)
        .set({ deletedAt: NOW.toISOString() })
        .where(eq(schema.comments.id, comment.id))
        .run();
      expect(getInbox(db, ana.id).notifications).toEqual([expected]);
    }
  });
});
