import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData, type TestDb } from "~/test/setup";
import * as schema from "~/db/schema";
import { UserRole } from "~/db/schema";
import { markdown } from "~/lib/text";
import { getInstructorAnalytics } from "./analytics.server";

// Midday, local time: refund windows count whole local days, so a fixed
// clock is what lets these tests talk about "today" at all.
const NOW = new Date(2026, 9, 6, 12, 0, 0);

function daysBefore(days: number) {
  const when = new Date(NOW);
  when.setDate(when.getDate() - days);
  return when.toISOString();
}

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
});

function addUser(name: string, role = UserRole.Student) {
  return db
    .insert(schema.users)
    .values({ name, email: `${name.toLowerCase()}@example.com`, role })
    .returning()
    .get();
}

function addCourse(instructorId: number, title: string) {
  return db
    .insert(schema.courses)
    .values({
      title,
      slug: title.toLowerCase().replace(/\s+/g, "-"),
      description: title,
      salesCopy: markdown(`## ${title}`),
      instructorId,
      categoryId: base.category.id,
      status: schema.CourseStatus.Published,
    })
    .returning()
    .get();
}

function buy(
  userId: number,
  daysAgo: number,
  amountPaid = 10000,
  courseId = base.course.id
) {
  db.insert(schema.purchases)
    .values({ userId, courseId, amountPaid, createdAt: daysBefore(daysAgo) })
    .run();
  db.insert(schema.enrollments)
    .values({ userId, courseId, enrolledAt: daysBefore(daysAgo) })
    .run();
}

function analyticsFor(
  viewer: { userId: number; isAdmin?: boolean },
  params: Record<string, string> = {},
  now = NOW
) {
  return getInstructorAnalytics(
    db,
    { userId: viewer.userId, isAdmin: viewer.isAdmin ?? false },
    new URLSearchParams(params),
    now
  );
}

describe("getInstructorAnalytics", () => {
  describe("revenue summary", () => {
    it("splits gross into fee and net over the range ending at now", () => {
      buy(base.user.id, 3, 10000);
      buy(addUser("Old").id, 40, 5000);

      const { summary } = analyticsFor({ userId: base.instructor.id });

      expect(summary).toEqual({
        grossCents: 10000,
        feeCents: 2000,
        netCents: 8000,
        purchaseCount: 1,
      });
    });

    it("measures the range from the now it is given, not the wall clock", () => {
      buy(base.user.id, 3, 10000);

      const later = new Date(NOW);
      later.setDate(later.getDate() + 30);

      expect(
        analyticsFor({ userId: base.instructor.id }, {}, later).summary
          .purchaseCount
      ).toBe(0);
    });

    it("ends the revenue chart on the bucket now falls in", () => {
      buy(base.user.id, 3, 10000);

      const { series } = analyticsFor(
        { userId: base.instructor.id },
        { range: "7d" }
      );

      expect(series.granularity).toBe("day");
      expect(series.points.at(-1)?.bucket).toBe(NOW.toISOString().slice(0, 10));
      expect(
        series.points.reduce((total, point) => total + point.grossCents, 0)
      ).toBe(10000);
    });
  });

  describe("refund exposure", () => {
    it("counts only purchases still inside their fourteen-day window", () => {
      buy(addUser("Fresh").id, 2, 10000);
      buy(addUser("Stale").id, 20, 4000);

      const { refundExposure } = analyticsFor({ userId: base.instructor.id });

      expect(refundExposure.grossCents).toBe(10000);
      expect(refundExposure.netCents).toBe(8000);
      expect(refundExposure.purchaseCount).toBe(1);
      expect(refundExposure.sharePercent).toBe(71);
      expect(refundExposure.courses).toEqual([
        {
          courseId: base.course.id,
          title: base.course.title,
          grossCents: 10000,
          purchaseCount: 1,
          daysLeft: 12,
        },
      ]);
    });

    it("keeps a purchase exposed through the whole of its fourteenth day", () => {
      buy(base.user.id, 14, 10000);

      const { refundExposure } = analyticsFor({ userId: base.instructor.id });

      expect(refundExposure.purchaseCount).toBe(1);
      expect(refundExposure.closingTodayCount).toBe(1);
      expect(refundExposure.courses[0].daysLeft).toBe(0);
    });

    it("releases a purchase the day after its window closes", () => {
      buy(base.user.id, 15, 10000);

      const { refundExposure } = analyticsFor({ userId: base.instructor.id });

      expect(refundExposure.purchaseCount).toBe(0);
      expect(refundExposure.grossCents).toBe(0);
    });

    it("heads each course with its most urgent purchase", () => {
      buy(addUser("Early").id, 13, 10000);
      buy(addUser("Late").id, 1, 10000);

      const { refundExposure } = analyticsFor({ userId: base.instructor.id });

      expect(refundExposure.courses[0].purchaseCount).toBe(2);
      expect(refundExposure.courses[0].daysLeft).toBe(1);
    });
  });

  describe("who sees what", () => {
    it("pins an instructor to their own courses whatever the URL asks", () => {
      const rival = addUser("Rival", UserRole.Instructor);
      const rivalCourse = addCourse(rival.id, "Rival Course");
      buy(base.user.id, 3, 10000);
      buy(addUser("Other").id, 3, 99900, rivalCourse.id);

      const analytics = analyticsFor(
        { userId: base.instructor.id },
        { instructor: String(rival.id), course: String(rivalCourse.id) }
      );

      expect(analytics.instructorId).toBe(base.instructor.id);
      expect(analytics.summary.grossCents).toBe(10000);
      // Another instructor's course is ignored rather than read.
      expect(analytics.selectedCourseId).toBeNull();
      expect(analytics.funnel).toBeNull();
    });

    it("shows an admin who picks nobody the whole platform", () => {
      const admin = addUser("Admin", UserRole.Admin);
      const rival = addUser("Rival", UserRole.Instructor);
      const rivalCourse = addCourse(rival.id, "Rival Course");
      buy(base.user.id, 3, 10000);
      buy(addUser("Other").id, 3, 5000, rivalCourse.id);

      const analytics = analyticsFor({ userId: admin.id, isAdmin: true });

      expect(analytics.instructorId).toBeNull();
      expect(analytics.summary.grossCents).toBe(15000);
      expect(analytics.instructors.map((one) => one.name)).toEqual([
        "Rival",
        "Test Instructor",
      ]);
    });

    it("lets an admin narrow to one instructor", () => {
      const admin = addUser("Admin", UserRole.Admin);
      const rival = addUser("Rival", UserRole.Instructor);
      const rivalCourse = addCourse(rival.id, "Rival Course");
      buy(base.user.id, 3, 10000);
      buy(addUser("Other").id, 3, 5000, rivalCourse.id);

      const analytics = analyticsFor(
        { userId: admin.id, isAdmin: true },
        { instructor: String(rival.id) }
      );

      expect(analytics.summary.grossCents).toBe(5000);
    });
  });

  describe("URL state", () => {
    it("falls back to the defaults for values it does not recognise", () => {
      const analytics = analyticsFor(
        { userId: base.instructor.id },
        { range: "forever", tab: "nonsense", course: "abc" }
      );

      expect(analytics.range).toBe("30d");
      expect(analytics.tab).toBe("overview");
      expect(analytics.selectedCourseId).toBeNull();
    });

    it("loads the course panels for a course the viewer owns", () => {
      buy(base.user.id, 3, 10000);

      const analytics = analyticsFor(
        { userId: base.instructor.id },
        { tab: "course", course: String(base.course.id) }
      );

      expect(analytics.tab).toBe("course");
      expect(analytics.selectedCourseId).toBe(base.course.id);
      expect(analytics.progress?.enrolledCount).toBe(1);
      expect(analytics.countries?.grossCents).toBe(10000);
    });
  });
});
