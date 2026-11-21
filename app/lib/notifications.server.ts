import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import {
  comments,
  coupons,
  courses,
  lessons,
  modules,
  notifications,
  purchases,
  refunds,
  users,
  NotificationKind,
  RefundStatus,
  UserRole,
} from "~/db/schema";
import { commentAnchor } from "~/lib/comments";
import {
  buyerPagePath,
  getSeats,
  kindOf,
  type PurchaseKind,
  type Queryable,
} from "~/lib/refunds.server";

// ─── Notifications ───
// The only code that reads or writes Notifications. See GLOSSARY.md.
//
// Three parts:
// - Headlines and links: what each kind of Notification says and where it
//   points, written once here.
// - Event recorders (`notify…`): each takes the id of the thing that just
//   happened, works out who to tell as things are right now, leaves out the
//   person who acted, and writes one Notification per recipient with its
//   headline and link. Callers never pass recipients, headlines or links.
// - The inbox: everything a person sees of their own Notifications.
//
// Every function that reads or writes takes the database first, so tests can
// hand in an in-memory one. Uses positional parameters (project convention).

// ─── Headlines and links ───
// The recorders build every Notification from these, and so does the seed. A
// headline may name people, courses and lessons, but never quotes a comment
// body, a Refund Request reason or a decision note.

export function refundRequestRaisedHeadline(
  buyerName: string,
  courseTitle: string
): string {
  return `${buyerName} raised a Refund Request for ${courseTitle}`;
}

export function refundRequestRaisedLink(): string {
  return "/admin/refunds";
}

export type RefundRequestDecision =
  RefundStatus.Approved | RefundStatus.Declined;

const DECISION_WORDS: Record<RefundRequestDecision, string> = {
  [RefundStatus.Approved]: "approved",
  [RefundStatus.Declined]: "declined",
};

export function refundRequestDecidedHeadline(
  courseTitle: string,
  decision: RefundRequestDecision
): string {
  return `Your Refund Request for ${courseTitle} was ${DECISION_WORDS[decision]}`;
}

export function refundRequestDecidedLink(purchaseKind: PurchaseKind): string {
  return buyerPagePath(purchaseKind);
}

export function replyHeadline(
  replierName: string,
  lessonTitle: string
): string {
  return `${replierName} replied to your comment on ${lessonTitle}`;
}

/** The reply itself, on its lesson page. */
export function replyLink(
  courseSlug: string,
  lessonId: number,
  replyId: number
): string {
  return `/courses/${courseSlug}/lessons/${lessonId}#${commentAnchor(replyId)}`;
}

export function newQuestionHeadline(
  authorName: string,
  lessonTitle: string
): string {
  return `${authorName} asked a Question on ${lessonTitle}`;
}

export function newQuestionLink(): string {
  return "/instructor/questions";
}

export function seatClaimedHeadline(
  studentName: string,
  courseTitle: string
): string {
  return `${studentName} claimed a Seat on ${courseTitle}`;
}

export function seatClaimedLink(): string {
  return "/team";
}

// ─── Event recorders ───

/**
 * A buyer has just raised a Refund Request. Tells every user who is a Platform
 * Admin right now, except the buyer. The headline never quotes the reason.
 */
export function notifyRefundRequestRaised(
  db: Queryable,
  refundRequestId: number
): void {
  const refundRequest = db
    .select({
      buyerId: users.id,
      buyerName: users.name,
      courseTitle: courses.title,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refunds.id, refundRequestId))
    .get();

  if (!refundRequest) return;

  // Nobody is told about their own action.
  const platformAdmins = db
    .select({ id: users.id })
    .from(users)
    .where(
      and(eq(users.role, UserRole.Admin), ne(users.id, refundRequest.buyerId))
    )
    .all();

  for (const platformAdmin of platformAdmins) {
    db.insert(notifications)
      .values({
        recipientId: platformAdmin.id,
        kind: NotificationKind.RefundRequestRaised,
        headline: refundRequestRaisedHeadline(
          refundRequest.buyerName,
          refundRequest.courseTitle
        ),
        link: refundRequestRaisedLink(),
      })
      .run();
  }
}

/**
 * A Student has just claimed a Seat. Tells the Team Admin who bought its Team
 * Licence, unless they claimed it themselves.
 */
export function notifySeatClaimed(db: Queryable, seatId: number): void {
  const seat = db
    .select({
      claimedByUserId: coupons.redeemedByUserId,
      buyerId: purchases.userId,
      courseTitle: courses.title,
    })
    .from(coupons)
    .innerJoin(purchases, eq(coupons.purchaseId, purchases.id))
    .innerJoin(courses, eq(coupons.courseId, courses.id))
    .where(eq(coupons.id, seatId))
    .get();

  if (!seat || seat.claimedByUserId === null) return;
  // Nobody is told about their own action.
  if (seat.claimedByUserId === seat.buyerId) return;

  const student = db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, seat.claimedByUserId))
    .get();

  if (!student) return;

  db.insert(notifications)
    .values({
      recipientId: seat.buyerId,
      kind: NotificationKind.SeatClaimed,
      headline: seatClaimedHeadline(student.name, seat.courseTitle),
      link: seatClaimedLink(),
    })
    .run();
}

/**
 * A Platform Admin has just approved or declined a Refund Request. Tells the
 * buyer which, unless they decided it themselves. Students on the Claimed
 * Seats of a Team Licence are not told: they didn't make the Purchase.
 */
export function notifyRefundRequestDecided(
  db: Queryable,
  refundRequestId: number
): void {
  const refundRequest = db
    .select({
      status: refunds.status,
      deciderId: refunds.resolvedByUserId,
      purchaseId: purchases.id,
      buyerId: purchases.userId,
      courseTitle: courses.title,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refunds.id, refundRequestId))
    .get();

  if (!refundRequest || refundRequest.status === RefundStatus.Open) return;
  // Nobody is told about their own action.
  if (refundRequest.deciderId === refundRequest.buyerId) return;

  const purchaseKind = kindOf(getSeats(db, refundRequest.purchaseId));

  db.insert(notifications)
    .values({
      recipientId: refundRequest.buyerId,
      kind: NotificationKind.RefundRequestDecided,
      headline: refundRequestDecidedHeadline(
        refundRequest.courseTitle,
        refundRequest.status
      ),
      link: refundRequestDecidedLink(purchaseKind),
    })
    .run();
}

/**
 * A comment has just been posted on a lesson. Works out what kind it is from
 * the comment itself:
 * - A reply tells the author of the top-level comment it replies to, unless
 *   they wrote the reply. Links to the reply itself on its lesson page.
 * - A Question (a top-level comment by a Student) tells the course's
 *   Instructor, unless they wrote it.
 * - A top-level comment by an Instructor or a Platform Admin isn't a Question
 *   and tells nobody.
 */
export function notifyCommentPosted(db: Queryable, commentId: number): void {
  const comment = db
    .select({
      id: comments.id,
      parentId: comments.parentId,
      authorId: comments.userId,
      authorName: users.name,
      authorRole: users.role,
      lessonId: comments.lessonId,
      lessonTitle: lessons.title,
      courseSlug: courses.slug,
      instructorId: courses.instructorId,
    })
    .from(comments)
    .innerJoin(users, eq(comments.userId, users.id))
    .innerJoin(lessons, eq(comments.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(eq(comments.id, commentId))
    .get();

  if (!comment) return;
  if (comment.parentId === null) notifyNewQuestion(db, comment);
  else notifyReply(db, { ...comment, parentId: comment.parentId });
}

function notifyReply(
  db: Queryable,
  reply: {
    id: number;
    parentId: number;
    authorId: number;
    authorName: string;
    lessonId: number;
    lessonTitle: string;
    courseSlug: string;
  }
): void {
  // Replies are one level deep, so the parent is the top-level comment.
  const parent = db
    .select({ authorId: comments.userId })
    .from(comments)
    .where(eq(comments.id, reply.parentId))
    .get();

  if (!parent) return;
  // Nobody is told about their own action.
  if (parent.authorId === reply.authorId) return;

  db.insert(notifications)
    .values({
      recipientId: parent.authorId,
      kind: NotificationKind.Reply,
      headline: replyHeadline(reply.authorName, reply.lessonTitle),
      link: replyLink(reply.courseSlug, reply.lessonId, reply.id),
    })
    .run();
}

function notifyNewQuestion(
  db: Queryable,
  question: {
    authorId: number;
    authorName: string;
    authorRole: UserRole;
    lessonTitle: string;
    instructorId: number;
  }
): void {
  // Only a Student's top-level comment is a Question.
  if (question.authorRole !== UserRole.Student) return;
  // Nobody is told about their own action.
  if (question.authorId === question.instructorId) return;

  db.insert(notifications)
    .values({
      recipientId: question.instructorId,
      kind: NotificationKind.NewQuestion,
      headline: newQuestionHeadline(question.authorName, question.lessonTitle),
      link: newQuestionLink(),
    })
    .run();
}

// ─── Inbox ───

export type InboxNotification = {
  id: number;
  kind: NotificationKind;
  headline: string;
  link: string;
  createdAt: string;
  isRead: boolean;
};

export type Inbox = {
  /** The newest few, read and unread, newest first. */
  notifications: InboxNotification[];
  /** Every unread Notification of the person's, not just those listed. */
  unreadCount: number;
  /** What the bell's badge says: nothing at 0, then the count, then "99+". */
  badgeLabel: string | null;
};

const INBOX_SIZE = 20;
const BADGE_MAX = 99;

function toBadgeLabel(unreadCount: number): string | null {
  if (unreadCount === 0) return null;
  if (unreadCount > BADGE_MAX) return `${BADGE_MAX}+`;
  return String(unreadCount);
}

export function getInbox(db: Queryable, userId: number): Inbox {
  const rows = db
    .select()
    .from(notifications)
    .where(eq(notifications.recipientId, userId))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(INBOX_SIZE)
    .all();

  const unread = db
    .select({ count: sql<number>`count(*)` })
    .from(notifications)
    .where(
      and(eq(notifications.recipientId, userId), isNull(notifications.readAt))
    )
    .get();
  const unreadCount = unread?.count ?? 0;

  return {
    notifications: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      headline: row.headline,
      link: row.link,
      createdAt: row.createdAt,
      isRead: row.readAt !== null,
    })),
    unreadCount,
    badgeLabel: toBadgeLabel(unreadCount),
  };
}

// ─── Read state ───
// Each change is scoped to the given person: asking to change someone else's
// Notification changes nothing. Only Notifications are touched, never the
// work queues they point at.

/** Marks one of the person's Notifications read. */
export function markRead(
  db: Queryable,
  userId: number,
  notificationId: number
): void {
  db.update(notifications)
    .set({ readAt: new Date().toISOString() })
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.recipientId, userId),
        isNull(notifications.readAt)
      )
    )
    .run();
}

/** Marks one of the person's Notifications unread, to come back to later. */
export function markUnread(
  db: Queryable,
  userId: number,
  notificationId: number
): void {
  db.update(notifications)
    .set({ readAt: null })
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.recipientId, userId)
      )
    )
    .run();
}

/** Marks every unread Notification of the person's read, not just the newest. */
export function markAllRead(db: Queryable, userId: number): void {
  db.update(notifications)
    .set({ readAt: new Date().toISOString() })
    .where(
      and(eq(notifications.recipientId, userId), isNull(notifications.readAt))
    )
    .run();
}
