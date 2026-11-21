import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { NotificationKind, UserRole } from "~/db/schema";
import {
  getInbox,
  notifyCommentPosted,
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
