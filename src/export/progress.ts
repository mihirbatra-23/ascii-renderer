import type { ExportProgress } from './types';

export type ProgressCallback = (progress: ExportProgress) => void;

/** 'Encoding frame 41 / 150' with a linear ETA once a few frames have been timed. */
export class FrameProgress {
  private readonly startedAt = performance.now();

  constructor(
    private readonly total: number | undefined,
    private readonly onProgress: ProgressCallback | undefined,
    private readonly verb = 'Encoding frame',
  ) {}

  report(done: number, fraction?: number): void {
    if (!this.onProgress) return;
    const total = this.total && this.total > 0 ? this.total : undefined;
    const f = fraction ?? (total ? Math.min(1, done / total) : null);
    const elapsed = (performance.now() - this.startedAt) / 1000;
    const etaSec = f && f > 0.02 && done >= 3 ? Math.max(0, (elapsed / f) * (1 - f)) : undefined;
    this.onProgress({
      fraction: f,
      label: total ? `${this.verb} ${Math.min(done, total)} / ${total}` : `${this.verb} ${done}`,
      etaSec,
    });
  }

  finishing(label = 'Finishing…'): void {
    this.onProgress?.({ fraction: 1, label });
  }
}
