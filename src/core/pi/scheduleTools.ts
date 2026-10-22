import { Type } from "typebox";
import { localTimeZone } from "../orchestrator/calendar";
import { scheduleText } from "../orchestrator/scheduler";
import { boundTool, stringEnum } from "../session/tools";
import type { ScheduleRecord, ScheduleSpec } from "../storage/scheduleStore";

/**
 * The Firstmate agent's scheduling tools (R3). The agent may create
 * schedules from a user ask or on its own judgment (captain decision Q4);
 * the guardrails are structural - a frequency floor, one feed line per
 * creation and cancellation, the active list riding the context block so
 * it never double-schedules, and a recurring schedule nobody directed
 * saved as a draft for the captain to turn on (docs/automation.md).
 */

export type ScheduleDelegate = {
  /**
   * `project` is a project key from the tasks index; unknown is refused.
   * A draft waits for the captain to turn it on, and so does a recurring
   * schedule made outside a captain's turn.
   */
  create(
    spec: ScheduleSpec,
    prompt: string,
    extra: { name?: string; project?: string; draft?: boolean },
  ): ScheduleRecord;
  /** Settings → Automation's Delete, by the catalog's automation-delete. */
  cancel(id: string): Promise<boolean>;
};

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export function createScheduleTools(delegate: ScheduleDelegate) {
  const schedule = boundTool({
    name: "schedule_prompt",
    label: "Schedule prompt",
    description: [
      "Schedule a prompt back to you as an [fm-op]. Pass one of every_minutes (min 15),",
      "daily_at (HH:MM; optional days and IANA time_zone, default local), at_time (ISO",
      "8601) or on_event (integration/event). The prompt carries all future-you needs.",
      "Runs only while the app does; missed runs fold into one. Pass draft if details",
      "are open.",
    ].join(" "),
    parameters: Type.Object({
      prompt: Type.String(),
      every_minutes: Type.Optional(Type.Number()),
      daily_at: Type.Optional(Type.String()),
      days: Type.Optional(Type.Array(stringEnum(WEEKDAYS))),
      time_zone: Type.Optional(Type.String()),
      at_time: Type.Optional(Type.String()),
      on_event: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
      project: Type.Optional(Type.String({ description: "Project key" })),
      draft: Type.Optional(Type.Boolean()),
    }),
    run: async (params) => {
      const spec = specFrom(params);
      const record = delegate.create(spec, params.prompt, {
        ...(params.name ? { name: params.name } : {}),
        ...(params.project ? { project: params.project } : {}),
        ...(params.draft ? { draft: true } : {}),
      });
      return {
        text:
          record.state === "draft"
            ? `Saved ${record.id} as a draft - ${scheduleText(record.spec)}. It runs only once turned on, which needs the captain: in Settings → Automation, or app_change automation-edit enable when asked. Cancel with cancel_schedule.`
            : `Scheduled ${record.id} - ${scheduleText(record.spec)}. Cancel with cancel_schedule.`,
      };
    },
  });

  const cancel = boundTool({
    name: "cancel_schedule",
    label: "Cancel schedule",
    description: "Cancel a schedule by its id (the context block lists them).",
    parameters: Type.Object({
      schedule_id: Type.String(),
    }),
    run: async (params) => {
      const cancelled = await delegate.cancel(params.schedule_id);
      return {
        text: cancelled
          ? `Cancelled schedule ${params.schedule_id}.`
          : `No schedule "${params.schedule_id}" exists; it may already be done or cancelled.`,
      };
    },
  });

  return [schedule, cancel];
}

function specFrom(params: {
  every_minutes?: number;
  daily_at?: string;
  days?: readonly (typeof WEEKDAYS)[number][];
  time_zone?: string;
  at_time?: string;
  on_event?: string;
}): ScheduleSpec {
  const set = [params.every_minutes, params.daily_at, params.at_time, params.on_event].filter(
    (value) => value !== undefined,
  );
  if (set.length !== 1) {
    throw new Error("Pass exactly one of every_minutes, daily_at, at_time, on_event.");
  }
  if ((params.days !== undefined || params.time_zone !== undefined) && !params.daily_at) {
    throw new Error("days and time_zone go with daily_at.");
  }
  if (params.on_event !== undefined) {
    const at = params.on_event.lastIndexOf("/");
    const integration = params.on_event.slice(0, at).trim();
    const event = params.on_event.slice(at + 1).trim();
    if (at < 0 || !integration || !event) {
      throw new Error(
        `on_event "${params.on_event}" is not integration/event, such as google/message_received.`,
      );
    }
    return { kind: "event", integration, event };
  }
  if (params.every_minutes !== undefined) {
    return { kind: "every", minutes: Math.round(params.every_minutes) };
  }
  if (params.daily_at !== undefined) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(params.daily_at.trim());
    if (!match) throw new Error(`daily_at "${params.daily_at}" is not HH:MM.`);
    const hour = Number.parseInt(match[1] as string, 10);
    const minute = Number.parseInt(match[2] as string, 10);
    const timeZone = params.time_zone?.trim() || localTimeZone();
    if (params.days !== undefined) {
      const days = params.days.map((day) => WEEKDAYS.indexOf(day));
      if (days.length === 0 || days.some((day) => day < 0)) {
        throw new Error(`days must name weekdays as ${WEEKDAYS.join(", ")}.`);
      }
      return { kind: "weekly", days, hour, minute, timeZone };
    }
    return { kind: "daily", hour, minute, timeZone };
  }
  const at = Date.parse(params.at_time ?? "");
  if (Number.isNaN(at)) {
    throw new Error(`at_time "${params.at_time}" is not a valid ISO 8601 date-time.`);
  }
  return { kind: "once", at };
}
