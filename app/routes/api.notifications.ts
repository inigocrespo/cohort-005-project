import { data } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/api.notifications";
import { getCurrentUserId } from "~/lib/session";
import { parseFormData } from "~/lib/validation";
import { db } from "~/db";
import { markAllRead, markRead, markUnread } from "~/lib/notifications.server";

// The one route that changes Notifications' read state. Submitting here makes
// every loader on the page revalidate, so the bell's badge follows along.
const notificationActionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("mark-read"),
    notificationId: z.coerce.number().int(),
  }),
  z.object({
    intent: z.literal("mark-unread"),
    notificationId: z.coerce.number().int(),
  }),
  z.object({ intent: z.literal("mark-all-read") }),
]);

export async function action({ request }: Route.ActionArgs) {
  const currentUserId = await getCurrentUserId(request);
  if (!currentUserId) {
    throw data("You must be logged in to manage notifications.", {
      status: 401,
    });
  }

  const parsed = parseFormData(
    await request.formData(),
    notificationActionSchema
  );
  if (!parsed.success) {
    throw data("Invalid parameters", { status: 400 });
  }

  // Each inbox function is scoped to the signed-in person, so another
  // person's Notification id changes nothing.
  switch (parsed.data.intent) {
    case "mark-read":
      markRead(db, currentUserId, parsed.data.notificationId);
      break;
    case "mark-unread":
      markUnread(db, currentUserId, parsed.data.notificationId);
      break;
    case "mark-all-read":
      markAllRead(db, currentUserId);
      break;
  }

  return { ok: true };
}
