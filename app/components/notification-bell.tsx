import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import {
  Armchair,
  Bell,
  MessageCircle,
  MessageSquareReply,
  Receipt,
} from "lucide-react";
import { NotificationKind } from "~/db/schema";
import type { Inbox, InboxNotification } from "~/lib/notifications.server";
import { cn, formatRelativeTime } from "~/lib/utils";

const KIND_ICONS: Record<NotificationKind, ReactNode> = {
  [NotificationKind.RefundRequestRaised]: <Receipt className="size-4" />,
  [NotificationKind.RefundRequestDecided]: <Receipt className="size-4" />,
  [NotificationKind.Reply]: <MessageSquareReply className="size-4" />,
  [NotificationKind.NewQuestion]: <MessageCircle className="size-4" />,
  [NotificationKind.SeatClaimed]: <Armchair className="size-4" />,
};

/**
 * The bell in the sidebar header and its dropdown of the person's newest
 * Notifications. The inbox comes from the app layout loader, so it refreshes
 * on every navigation and action, never live.
 */
export function NotificationBell({ inbox }: { inbox: Inbox }) {
  const [isOpen, setIsOpen] = useState(false);
  const navigate = useNavigate();

  function open(notification: InboxNotification) {
    setIsOpen(false);
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
            <div className="border-b px-4 py-2.5">
              <span className="text-sm font-semibold">Notifications</span>
            </div>
            <div className="overflow-y-auto">
              {inbox.notifications.length === 0 && (
                <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                  <Bell className="mx-auto mb-2 size-5 opacity-50" />
                  No notifications yet.
                </div>
              )}
              {inbox.notifications.map((notification) => (
                <button
                  key={notification.id}
                  type="button"
                  onClick={() => open(notification)}
                  className={cn(
                    "flex w-full items-start gap-3 border-b px-4 py-3 text-left last:border-b-0 hover:bg-accent/60",
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
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
}
