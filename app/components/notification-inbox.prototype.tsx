// PROTOTYPE, throwaway: do not merge to main.
// Three variants of the Notification inbox, switchable via `?variant=`, mounted
// in the real app layout. Question: where does the entry point live, is it a
// dropdown or a page, and how do read/unread, mark-all-read and click-through
// behave? All Notifications are mock data held in memory (see wayfinder ticket
// "What should the Notification inbox look and behave like?").
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useNavigate, useSearchParams } from "react-router";
import {
  AlertTriangle,
  Armchair,
  Bell,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  MessageCircle,
  MessageSquareReply,
  Receipt,
  X,
} from "lucide-react";
import { UserRole } from "~/db/schema";
import { cn } from "~/lib/utils";

type Audience = "admin" | "instructor" | "student" | "teamAdmin";
type Variant = "A" | "B" | "C";
type Scenario = "normal" | "empty" | "busy";

interface MockNotification {
  id: string;
  event:
    | "refund-raised"
    | "refund-decided"
    | "failed-refund"
    | "reply"
    | "question"
    | "seat-claimed";
  title: string;
  detail: string;
  when: string;
  to: string;
  needsAction: boolean;
  read: boolean;
}

const VARIANTS: Record<Variant, string> = {
  A: "Bell + dropdown",
  B: "Nav item + full page",
  C: "Footer bell + triage panel",
};

const VARIANT_KEYS = Object.keys(VARIANTS) as Variant[];

const MOCK: Record<Audience, MockNotification[]> = {
  admin: [
    {
      id: "a1",
      event: "failed-refund",
      title: "Failed Refund",
      detail: "$79 to Liam Thompson for Introduction to TypeScript couldn't be sent",
      when: "12m",
      // No Failed Refund view exists yet, so this lands on approved requests.
      to: "/admin/refunds?status=approved",
      needsAction: true,
      read: false,
    },
    {
      id: "a2",
      event: "refund-raised",
      title: "Refund Request raised",
      detail: "Emma Wilson on Building REST APIs with Node.js",
      when: "1h",
      to: "/admin/refunds?status=open",
      needsAction: true,
      read: false,
    },
    {
      id: "a3",
      event: "refund-raised",
      title: "Refund Request raised",
      detail: "Bossy McBossface on a Team Licence for Design Systems with Tailwind",
      when: "Yesterday",
      to: "/admin/refunds?status=open",
      needsAction: true,
      read: true,
    },
  ],
  instructor: [
    {
      id: "i1",
      event: "question",
      title: "New Question",
      detail: "James Park asked on “Generics in practice”",
      when: "8m",
      to: "/instructor/questions",
      needsAction: true,
      read: false,
    },
    {
      id: "i2",
      event: "reply",
      title: "Reply to your comment",
      detail: "Olivia Martinez replied on “Setting up your environment”",
      when: "3h",
      to: "/courses/introduction-to-typescript/lessons/1",
      needsAction: false,
      read: false,
    },
    {
      id: "i3",
      event: "question",
      title: "New Question",
      detail: "Sophia Davis asked on “Type narrowing”",
      when: "2d",
      to: "/instructor/questions",
      needsAction: true,
      read: true,
    },
  ],
  student: [
    {
      id: "s1",
      event: "refund-decided",
      title: "Refund Request approved",
      detail: "Introduction to TypeScript: your $79 Refund is on its way",
      when: "20m",
      to: "/settings",
      needsAction: false,
      read: false,
    },
    {
      id: "s2",
      event: "reply",
      title: "Reply to your comment",
      detail: "Sarah Chen replied on “Setting up your environment”",
      when: "4h",
      to: "/courses/introduction-to-typescript/lessons/1",
      needsAction: false,
      read: false,
    },
    {
      id: "s3",
      event: "refund-decided",
      title: "Refund Request declined",
      detail: "Building REST APIs with Node.js: you can raise a new one",
      when: "3d",
      to: "/settings",
      needsAction: false,
      read: true,
    },
  ],
  teamAdmin: [
    {
      id: "t1",
      event: "seat-claimed",
      title: "Seat claimed",
      detail: "Noah Blackwood claimed a Seat on Design Systems with Tailwind",
      when: "30m",
      to: "/team",
      needsAction: false,
      read: false,
    },
    {
      id: "t2",
      event: "refund-decided",
      title: "Refund Request declined",
      detail: "Your Team Licence for Introduction to TypeScript",
      when: "5h",
      to: "/team",
      needsAction: false,
      read: false,
    },
    {
      id: "t3",
      event: "seat-claimed",
      title: "Seat claimed",
      detail: "Isla Fernandes claimed a Seat on Design Systems with Tailwind",
      when: "1w",
      to: "/team",
      needsAction: false,
      read: true,
    },
  ],
};

function buildItems(audience: Audience, scenario: Scenario) {
  if (scenario === "empty") return [];
  if (scenario === "normal") return MOCK[audience].map((n) => ({ ...n }));
  return Array.from({ length: 8 }, (_, round) =>
    MOCK[audience].map((n) => ({ ...n, id: `${n.id}-${round}` }))
  ).flat();
}

function isVariant(value: string | null): value is Variant {
  return value === "A" || value === "B" || value === "C";
}

interface InboxContextValue {
  audience: Audience;
  variant: Variant;
  setVariant: (variant: Variant) => void;
  scenario: Scenario;
  setScenario: (scenario: Scenario) => void;
  items: MockNotification[];
  unread: number;
  isOpen: boolean;
  setOpen: (open: boolean) => void;
  isPageOpen: boolean;
  openPage: () => void;
  toggleRead: (id: string) => void;
  markAllRead: () => void;
  openItem: (item: MockNotification) => void;
  lastAction: string;
}

const InboxContext = createContext<InboxContextValue | null>(null);

export function NotificationInboxPrototype({
  role,
  isTeamAdmin,
  children,
}: {
  role: UserRole | null;
  isTeamAdmin: boolean;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlVariant = searchParams.get("variant");
  const [variant, setVariantState] = useState<Variant>(
    isVariant(urlVariant) ? urlVariant : "A"
  );
  const [scenario, setScenarioState] = useState<Scenario>("normal");
  const [byAudience, setByAudience] = useState<
    Partial<Record<Audience, MockNotification[]>>
  >({});
  const [isOpen, setOpen] = useState(false);
  const [lastAction, setLastAction] = useState("none yet");

  const audience: Audience | null =
    role === UserRole.Admin
      ? "admin"
      : role === UserRole.Instructor
        ? "instructor"
        : role === UserRole.Student
          ? isTeamAdmin
            ? "teamAdmin"
            : "student"
          : null;

  // Keeps the variant in the URL as the user clicks through to other pages.
  useEffect(() => {
    if (isVariant(urlVariant)) {
      if (urlVariant !== variant) setVariantState(urlVariant);
      return;
    }
    setSearchParams(
      (params) => {
        params.set("variant", variant);
        return params;
      },
      { replace: true }
    );
  }, [urlVariant, variant, setSearchParams]);

  const value = useMemo<InboxContextValue | null>(() => {
    if (!audience) return null;
    const current = audience;
    const items = byAudience[current] ?? buildItems(current, scenario);

    function update(next: MockNotification[]) {
      setByAudience((all) => ({ ...all, [current]: next }));
    }

    return {
      audience: current,
      variant,
      setVariant(next) {
        setOpen(false);
        setSearchParams(
          (params) => {
            params.set("variant", next);
            params.delete("inbox");
            return params;
          },
          { replace: true }
        );
      },
      scenario,
      setScenario(next) {
        setScenarioState(next);
        setByAudience({});
        setLastAction(`scenario: ${next}`);
      },
      items,
      unread: items.filter((n) => !n.read).length,
      isOpen,
      setOpen,
      isPageOpen: searchParams.get("inbox") === "1",
      openPage() {
        setSearchParams((params) => {
          params.set("inbox", "1");
          return params;
        });
      },
      toggleRead(id) {
        const target = items.find((n) => n.id === id);
        update(
          items.map((n) => (n.id === id ? { ...n, read: !n.read } : n))
        );
        setLastAction(
          `marked ${target?.read ? "unread" : "read"}: ${target?.title}`
        );
      },
      markAllRead() {
        update(items.map((n) => ({ ...n, read: true })));
        setLastAction("marked all read");
      },
      openItem(item) {
        update(
          items.map((n) => (n.id === item.id ? { ...n, read: true } : n))
        );
        setOpen(false);
        setLastAction(`opened: ${item.title} → ${item.to}`);
        const [path, query] = item.to.split("?");
        const params = new URLSearchParams(query);
        params.set("variant", variant);
        navigate(`${path}?${params}`);
      },
      lastAction,
    };
  }, [
    audience,
    byAudience,
    scenario,
    variant,
    isOpen,
    searchParams,
    setSearchParams,
    navigate,
    lastAction,
  ]);

  return (
    <InboxContext.Provider value={value}>{children}</InboxContext.Provider>
  );
}

function useInbox() {
  return useContext(InboxContext);
}

const EVENT_ICONS: Record<MockNotification["event"], ReactNode> = {
  "refund-raised": <Receipt className="size-4" />,
  "refund-decided": <Receipt className="size-4" />,
  "failed-refund": <AlertTriangle className="size-4 text-destructive" />,
  reply: <MessageSquareReply className="size-4" />,
  question: <MessageCircle className="size-4" />,
  "seat-claimed": <Armchair className="size-4" />,
};

function UnreadBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground">
      {count > 9 ? "9+" : count}
    </span>
  );
}

function BellButton({ inbox }: { inbox: InboxContextValue }) {
  return (
    <button
      type="button"
      title="Notifications"
      aria-label={`Notifications, ${inbox.unread} unread`}
      onClick={() => inbox.setOpen(!inbox.isOpen)}
      className="relative rounded-md p-1.5 text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
    >
      <Bell className="size-4" />
      <span className="absolute -right-1 -top-1">
        <UnreadBadge count={inbox.unread} />
      </span>
    </button>
  );
}

function ReadToggle({
  inbox,
  item,
}: {
  inbox: InboxContextValue;
  item: MockNotification;
}) {
  return (
    <button
      type="button"
      title={item.read ? "Mark as unread" : "Mark as read"}
      onClick={(event) => {
        event.stopPropagation();
        inbox.toggleRead(item.id);
      }}
      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
    >
      {item.read ? (
        <CircleDot className="size-3.5 opacity-40" />
      ) : (
        <Check className="size-3.5" />
      )}
    </button>
  );
}

function MarkAllRead({ inbox }: { inbox: InboxContextValue }) {
  return (
    <button
      type="button"
      disabled={inbox.unread === 0}
      onClick={inbox.markAllRead}
      className="text-xs font-medium text-primary hover:underline disabled:text-muted-foreground disabled:no-underline"
    >
      Mark all read
    </button>
  );
}

function EmptyState() {
  return (
    <div className="px-4 py-10 text-center text-sm text-muted-foreground">
      <Bell className="mx-auto mb-2 size-5 opacity-50" />
      You're all caught up.
    </div>
  );
}

// Variant A: a compact bell in the sidebar header opening a dropdown.
function DropdownInbox({ inbox }: { inbox: InboxContextValue }) {
  if (!inbox.isOpen) return null;
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={() => inbox.setOpen(false)} />
      <div className="fixed left-[13.5rem] top-2 z-40 flex max-h-[28rem] w-96 flex-col rounded-lg border bg-popover text-popover-foreground shadow-xl">
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <span className="text-sm font-semibold">Notifications</span>
          <MarkAllRead inbox={inbox} />
        </div>
        <div className="overflow-y-auto">
          {inbox.items.length === 0 && <EmptyState />}
          {inbox.items.map((item) => (
            <div
              key={item.id}
              role="button"
              tabIndex={0}
              onClick={() => inbox.openItem(item)}
              className={cn(
                "flex cursor-pointer items-start gap-3 border-b px-4 py-3 last:border-b-0 hover:bg-accent/60",
                !item.read && "bg-primary/5"
              )}
            >
              <span className="mt-0.5 text-muted-foreground">
                {EVENT_ICONS[item.event]}
              </span>
              <div className="min-w-0 flex-1">
                <div className={cn("text-sm", !item.read && "font-semibold")}>
                  {item.title}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {item.detail}
                </div>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">
                {item.when}
              </span>
              <ReadToggle inbox={inbox} item={item} />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// Variant B: a sidebar nav item leading to a full page, laid out as a table.
function PageInbox({ inbox }: { inbox: InboxContextValue }) {
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const rows = inbox.items.filter((n) => filter === "all" || !n.read);
  return (
    <div className="mx-auto max-w-4xl p-8">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold">Notifications</h1>
          <p className="text-sm text-muted-foreground">
            {inbox.unread} unread of {inbox.items.length}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex rounded-md border p-0.5 text-xs">
            {(["all", "unread"] as const).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className={cn(
                  "rounded px-3 py-1 capitalize",
                  filter === key && "bg-accent font-medium"
                )}
              >
                {key}
              </button>
            ))}
          </div>
          <MarkAllRead inbox={inbox} />
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="rounded-lg border">
          <EmptyState />
        </div>
      ) : (
        <table className="w-full overflow-hidden rounded-lg border text-sm">
          <tbody>
            {rows.map((item) => (
              <tr
                key={item.id}
                onClick={() => inbox.openItem(item)}
                className={cn(
                  "cursor-pointer border-b last:border-b-0 hover:bg-accent/60",
                  !item.read && "bg-primary/5"
                )}
              >
                <td className="w-10 py-3 pl-4 text-muted-foreground">
                  {EVENT_ICONS[item.event]}
                </td>
                <td
                  className={cn(
                    "w-52 whitespace-nowrap py-3 pr-4",
                    !item.read && "font-semibold"
                  )}
                >
                  {item.title}
                </td>
                <td className="py-3 pr-4 text-muted-foreground">
                  {item.detail}
                </td>
                <td className="w-20 whitespace-nowrap py-3 pr-2 text-right text-xs text-muted-foreground">
                  {item.when}
                </td>
                <td className="w-10 pr-3">
                  <ReadToggle inbox={inbox} item={item} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// Variant C: a bell by the user's name opening a full-height panel beside the
// sidebar, split into what needs doing and what is just news.
function TriagePanel({ inbox }: { inbox: InboxContextValue }) {
  if (!inbox.isOpen) return null;
  const groups = [
    {
      label: "Needs you",
      rows: inbox.items.filter((n) => n.needsAction && !n.read),
    },
    {
      label: "Updates",
      rows: inbox.items.filter((n) => !n.needsAction && !n.read),
    },
    { label: "Earlier", rows: inbox.items.filter((n) => n.read) },
  ].filter((group) => group.rows.length > 0);

  return (
    <aside className="fixed bottom-0 left-56 top-0 z-40 flex w-[26rem] flex-col border-r bg-background shadow-2xl">
      <div className="flex h-14 items-center justify-between border-b px-4">
        <span className="font-semibold">Inbox</span>
        <div className="flex items-center gap-3">
          <MarkAllRead inbox={inbox} />
          <button
            type="button"
            title="Close"
            onClick={() => inbox.setOpen(false)}
            className="rounded p-1 text-muted-foreground hover:bg-accent"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto p-4 pb-20">
        {groups.length === 0 && <EmptyState />}
        {groups.map((group) => (
          <section key={group.label}>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {group.label} · {group.rows.length}
            </h2>
            <div className="space-y-2">
              {group.rows.map((item) => (
                <div
                  key={item.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => inbox.openItem(item)}
                  className={cn(
                    "cursor-pointer rounded-lg border p-3 hover:border-primary/50",
                    item.read && "opacity-60"
                  )}
                >
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {EVENT_ICONS[item.event]}
                    <span className="flex-1">{item.title}</span>
                    <span className="text-xs font-normal text-muted-foreground">
                      {item.when}
                    </span>
                    <ReadToggle inbox={inbox} item={item} />
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {item.detail}
                  </p>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </aside>
  );
}

export function InboxHeaderSlot() {
  const inbox = useInbox();
  if (!inbox || inbox.variant !== "A") return null;
  return <BellButton inbox={inbox} />;
}

export function InboxNavSlot() {
  const inbox = useInbox();
  if (!inbox || inbox.variant !== "B") return null;
  return (
    <button
      type="button"
      onClick={inbox.openPage}
      className={cn(
        "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
        inbox.isPageOpen
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      )}
    >
      <Bell className="size-4" />
      <span className="flex-1 text-left">Notifications</span>
      <UnreadBadge count={inbox.unread} />
    </button>
  );
}

export function InboxFooterSlot() {
  const inbox = useInbox();
  if (!inbox || inbox.variant !== "C") return null;
  return <BellButton inbox={inbox} />;
}

export function InboxMain({ children }: { children: ReactNode }) {
  const inbox = useInbox();
  if (inbox?.variant === "B" && inbox.isPageOpen) {
    return <PageInbox inbox={inbox} />;
  }
  return <>{children}</>;
}

export function InboxOverlays() {
  const inbox = useInbox();

  useEffect(() => {
    if (!inbox) return;
    const { variant, setVariant } = inbox;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target as HTMLElement;
      if (
        target.closest("input, textarea, select, [contenteditable='true']")
      ) {
        return;
      }
      const step = event.key === "ArrowLeft" ? -1 : 1;
      const index = VARIANT_KEYS.indexOf(variant);
      const count = VARIANT_KEYS.length;
      setVariant(VARIANT_KEYS[(index + step + count) % count]);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [inbox]);

  if (!inbox) return null;
  const index = VARIANT_KEYS.indexOf(inbox.variant);
  const count = VARIANT_KEYS.length;

  return (
    <>
      {inbox.variant === "A" && <DropdownInbox inbox={inbox} />}
      {inbox.variant === "C" && <TriagePanel inbox={inbox} />}
      <div className="fixed bottom-4 left-1/2 z-[60] -translate-x-1/2 rounded-2xl bg-zinc-900 px-3 py-2 text-xs text-zinc-100 shadow-2xl ring-1 ring-white/20">
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            title="Previous variant"
            onClick={() =>
              inbox.setVariant(VARIANT_KEYS[(index - 1 + count) % count])
            }
            className="rounded p-1 hover:bg-white/15"
          >
            <ChevronLeft className="size-4" />
          </button>
          <span className="min-w-48 text-center font-semibold">
            {inbox.variant} ({VARIANTS[inbox.variant]})
          </span>
          <button
            type="button"
            title="Next variant"
            onClick={() => inbox.setVariant(VARIANT_KEYS[(index + 1) % count])}
            className="rounded p-1 hover:bg-white/15"
          >
            <ChevronRight className="size-4" />
          </button>
          <span className="mx-1 h-4 w-px bg-white/25" />
          {(["normal", "empty", "busy"] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => inbox.setScenario(key)}
              className={cn(
                "rounded px-2 py-0.5 capitalize hover:bg-white/15",
                inbox.scenario === key && "bg-white/25"
              )}
            >
              {key}
            </button>
          ))}
        </div>
        <div className="mt-1 text-center font-mono text-[10px] text-zinc-400">
          {inbox.audience} · {inbox.unread} unread / {inbox.items.length} ·
          last: {inbox.lastAction}
        </div>
      </div>
    </>
  );
}
