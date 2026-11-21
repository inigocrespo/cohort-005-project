import { useState, type ReactNode } from "react";
import { useFetcher, useNavigate } from "react-router";
import {
  Armchair,
  Bell,
  Check,
  CircleDot,
  MessageCircle,
  MessageSquareReply,
  Receipt,
} from "lucide-react";
import { NotificationKind } from "~/db/schema";
import type { Inbox, InboxNotification } from "~/lib/notifications.server";
import { NotificationIntent } from "~/lib/notification-intents";
import { cn, formatRelativeTime } from "~/lib/utils";

const KIND_ICONS: Record<NotificationKind, ReactNode> = {
  [NotificationKind.RefundRequestRaised]: <Receipt className="size-4" />,
  [NotificationKind.RefundRequestDecided]: <Receipt className="size-4" />,
  [NotificationKind.Reply]: <MessageSquareReply className="size-4" />,
  [NotificationKind.NewQuestion]: <MessageCircle className="size-4" />,
  [NotificationKind.SeatClaimed]: <Armchair className="size-4" />,
};

// Every read-state change goes through this one action route. Its submissions
// revalidate the layout loader, so the badge follows along.
const NOTIFICATIONS_ACTION = "/api/notifications";

/**
 * The bell in the sidebar header and its dropdown of the person's newest
 * Notifications. The inbox comes from the app layout loader, so it refreshes
 * on every navigation and action, never live.
 */
export function NotificationBell({ inbox }: { inbox: Inbox }) {
  const [isOpen, setIsOpen] = useState(false);
  const navigate = useNavigate();
  const markReadFetcher = useFetcher();

  // Marks it read, then follows its stored link. The destination page does
  // its own checks on the subject; the bell does none.
  async function open(notification: InboxNotification) {
    setIsOpen(false);
    if (!notification.isRead) {
      await markReadFetcher.submit(
        {
          intent: NotificationIntent.MarkRead,
          notificationId: notification.id,
        },
        { method: "post", action: NOTIFICATIONS_ACTION }
      );
    }
    navigate(notification.link);
  }

  return (
    <>
      <button
        type="button"
        title="Notifications"
        aria-label={`Notifications, ${inbox.unreadCount} unread`}
        aria-expanded={isOpen}
        onClick={() => setIsOpen(!isOpen)}
        className="relative rounded-md p-1.5 text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      >
        <Bell className="size-4" />
        {inbox.badgeLabel && (
          <span className="absolute -right-1 -top-1 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground">
            {inbox.badgeLabel}
          </span>
        )}
      </button>

      {isOpen && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setIsOpen(false)}
          />
          <div className="fixed left-[13.5rem] top-2 z-40 flex max-h-[28rem] w-96 flex-col rounded-lg border bg-popover text-popover-foreground shadow-xl">
            <div className="flex items-center justify-between border-b px-4 py-2.5">
              <span className="text-sm font-semibold">Notifications</span>
              <MarkAllRead disabled={inbox.unreadCount === 0} />
            </div>
            <div className="overflow-y-auto">
              {inbox.notifications.length === 0 && (
                <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                  <Bell className="mx-auto mb-2 size-5 opacity-50" />
                  No notifications yet.
                </div>
              )}
              {inbox.notifications.map((notification) => (
                <div
                  key={notification.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => open(notification)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      open(notification);
                    }
                  }}
                  className={cn(
                    "flex w-full cursor-pointer items-start gap-3 border-b px-4 py-3 text-left last:border-b-0 hover:bg-accent/60",
                    !notification.isRead && "bg-primary/5"
                  )}
                >
                  <span className="mt-0.5 text-muted-foreground">
                    {KIND_ICONS[notification.kind]}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1 text-sm",
                      !notification.isRead && "font-semibold"
                    )}
                  >
                    {notification.headline}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatRelativeTime(notification.createdAt)}
                  </span>
                  <ReadToggle notification={notification} />
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
}

/** Flips one Notification read or unread without leaving the page. */
function ReadToggle({ notification }: { notification: InboxNotification }) {
  const fetcher = useFetcher();
  const label = notification.isRead ? "Mark as unread" : "Mark as read";

  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(event) => {
        // The row itself opens the Notification; the toggle mustn't.
        event.stopPropagation();
        fetcher.submit(
          {
            intent: notification.isRead
              ? NotificationIntent.MarkUnread
              : NotificationIntent.MarkRead,
            notificationId: notification.id,
          },
          { method: "post", action: NOTIFICATIONS_ACTION }
        );
      }}
      onKeyDown={(event) => event.stopPropagation()}
      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
    >
      {notification.isRead ? (
        <CircleDot className="size-3.5 opacity-40" />
      ) : (
        <Check className="size-3.5" />
      )}
    </button>
  );
}

/** Marks every one of the person's Notifications read, not just those listed. */
function MarkAllRead({ disabled }: { disabled: boolean }) {
  const fetcher = useFetcher();

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() =>
        fetcher.submit(
          { intent: NotificationIntent.MarkAllRead },
          { method: "post", action: NOTIFICATIONS_ACTION }
        )
      }
      className="text-xs font-medium text-primary hover:underline disabled:text-muted-foreground disabled:no-underline"
    >
      Mark all read
    </button>
  );
}
