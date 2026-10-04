/**
 * Reference-counted disposal for loaded media. The app disposes media as soon as the user opens or
 * closes a file, while an export may still be reading frames from it; every reader therefore holds a
 * retain, and the resources are released only once the media is disposed AND every retain is released.
 */

/** What reading a disposed media rejects with (exports surface it, so it is written for users). */
export const CLOSED_MESSAGE = 'The file was closed before it could be read.';

export class Lifetime {
  private holds = 0;
  private disposeRequested = false;
  private released = false;

  constructor(private readonly release: () => void) {}

  /** False once the resources have been released (disposed with no retains left). */
  get alive(): boolean {
    return !this.released;
  }

  /** Keeps the resources alive until the returned function is called (calling it again does nothing). */
  retain(): () => void {
    if (this.released) throw new Error(CLOSED_MESSAGE);
    this.holds++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.holds--;
      this.settle();
    };
  }

  /** Releases the resources now, or as soon as the last retain is released. Idempotent. */
  dispose(): void {
    this.disposeRequested = true;
    this.settle();
  }

  /** The retain / dispose pair a LoadedMedia exposes. */
  members(): { retain: () => () => void; dispose: () => void } {
    return { retain: () => this.retain(), dispose: () => this.dispose() };
  }

  private settle(): void {
    if (this.released || !this.disposeRequested || this.holds > 0) return;
    this.released = true;
    this.release();
  }
}

/** The retain / dispose pair of a new Lifetime, for media that need nothing else from it. */
export function lifetimeMembers(release: () => void): { retain: () => () => void; dispose: () => void } {
  return new Lifetime(release).members();
}
