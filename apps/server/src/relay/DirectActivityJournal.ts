import type { DirectActivityEvent, DirectActivityBatch } from "@t3tools/contracts";
import type { EnvironmentId } from "@t3tools/contracts";

/** A process-scoped bounded replay window. Reset never replays historical completions. */
export class DirectActivityJournal {
  private sequence = 0;
  private events: Array<{ sequence: number; event: DirectActivityEvent }> = [];
  private readonly environmentId: EnvironmentId;
  private readonly epoch: string;
  constructor(environmentId: EnvironmentId, epoch: string) {
    this.environmentId = environmentId;
    this.epoch = epoch;
  }

  append(event: DirectActivityEvent): void {
    this.events.push({ sequence: ++this.sequence, event });
    if (this.events.length > 1000) this.events.shift();
  }

  read(cursor: string | null): DirectActivityBatch {
    const match = cursor?.match(/^([\w-]+):(\d+)$/);
    const sequence = match ? Number(match[2]) : -1;
    const oldest = this.events[0]?.sequence ?? this.sequence + 1;
    const reset =
      !match || match[1] !== this.epoch || sequence < oldest - 1 || sequence > this.sequence;
    const page = reset
      ? []
      : this.events.filter((event) => event.sequence > sequence).slice(0, 100);
    const last = page.at(-1)?.sequence ?? this.sequence;
    return {
      environmentId: this.environmentId,
      cursor: `${this.epoch}:${last}`,
      reset,
      more: last < this.sequence,
      events: page.map((entry) => entry.event),
    };
  }
}
