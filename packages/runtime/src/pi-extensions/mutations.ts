/**
 * Legacy extension setters acknowledge staging synchronously. Hosts must await
 * flush before controlled effects and command acknowledgements. Rejections stay
 * latched even when Pi catches an extension handler error.
 */
export class PiExtensionMutations {
  private tail: Promise<void> = Promise.resolve();
  private failure?: { error: unknown };
  private closed = false;
  private drained = false;
  private readonly notifications = new Set<Promise<unknown>>();

  stage<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("Pi extension activation is closed");
    const pending = this.tail.then(async () => {
      if (this.failure) throw this.failure.error;
      return operation();
    });
    this.tail = pending.then(
      () => {},
      (error: unknown) => {
        this.failure ??= { error };
      },
    );
    // Pi's synchronous extension actions cannot await this promise. The tail owns
    // its rejection; callers with an async acknowledgement still receive pending.
    return pending;
  }

  assertHealthy() {
    this.assertCommitHealthy();
    if (this.closed) throw new Error("Pi extension activation is closed");
  }

  /** Required adapter failures must survive Pi's isolated behavior-hook errors. */
  fail(error: unknown): never {
    this.failure ??= { error };
    throw this.failure.error;
  }

  /** Accepted metadata commits may drain after admission closes; failures still fence them. */
  assertCommitHealthy() {
    if (this.failure) throw this.failure.error;
  }

  assertReadable() {
    this.assertCommitHealthy();
    if (this.drained) throw new Error("Pi extension activation is closed");
  }

  /** Notifications run outside the mutation line so nested async setters cannot deadlock it. */
  track<T>(notification: Promise<T>): Promise<T> {
    if (this.closed) throw new Error("Pi extension activation is closed");
    this.notifications.add(notification);
    void notification.then(
      () => {
        this.notifications.delete(notification);
      },
      (error: unknown) => {
        this.failure ??= { error };
        this.notifications.delete(notification);
      },
    );
    return notification;
  }

  private async drain() {
    let observed: Promise<void>;
    do {
      observed = this.tail;
      await Promise.allSettled([observed, ...this.notifications]);
    } while (observed !== this.tail || this.notifications.size);
  }

  async flush() {
    await this.drain();
    this.assertHealthy();
  }

  async close() {
    this.closed = true;
    try {
      await this.drain();
      if (this.failure) throw this.failure.error;
    } finally {
      this.drained = true;
    }
  }
}
