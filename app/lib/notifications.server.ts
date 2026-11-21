import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import {
  coupons,
  courses,
  notifications,
  purchases,
  refunds,
  users,
  NotificationKind,
  RefundStatus,
} from "~/db/schema";

// ─── Notifications ───
// The only code that reads or writes Notifications. See GLOSSARY.md.
//
// Two halves:
// - Event recorders (`notify…`): each takes the id of the thing that just
//   happened, works out who to tell as things are right now, leaves out the
//   person who acted, and writes one Notification per recipient with its
//   headline and link. Callers never pass recipients, headlines or links.
// - The inbox: everything a person sees of their own Notifications.
//
// Every function takes the database first, so tests can hand in an in-memory
// one. Uses positional parameters (project convention).

export type Db = BetterSQLite3Database<typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Queryable = Db | Tx;

// ─── Event recorders ───

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
      headline: `${student.name} claimed a Seat on ${seat.courseTitle}`,
      link: "/team",
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

  // A Team Licence is the Purchase that granted Seats (see refunds.server).
  const grantedSeat = db
    .select({ id: coupons.id })
    .from(coupons)
    .where(eq(coupons.purchaseId, refundRequest.purchaseId))
    .get();

  db.insert(notifications)
    .values({
      recipientId: refundRequest.buyerId,
      kind: NotificationKind.RefundRequestDecided,
      headline: `Your refund request for ${refundRequest.courseTitle} was ${refundRequest.status}`,
      link: grantedSeat ? "/team" : "/settings",
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
