// The read-state changes the bell asks the Notifications action route for.
// Defined once here, outside any .server module, so the bell and the route
// share them.
export enum NotificationIntent {
  MarkRead = "mark-read",
  MarkUnread = "mark-unread",
  MarkAllRead = "mark-all-read",
}
