/**
 * One wake per account for the same provider refusal (docs/inbox.md, "The
 * same refusal on one account"). A provider can refuse an account rather
 * than a request - new terms to accept, say - and then every crewmate on
 * that account meets the same words. The host does not judge which it is:
 * it compares the words (`refusalWords`) and the account, both facts it
 * holds. The first refusal on an account wakes the first mate, naming the
 * other open tasks on it; a later one in the same words on that account
 * wakes nobody until a turn on the account goes through, and a lane on it
 * that gets stuck in those words is not told again either: the task that
 * woke the first mate is the one told.
 *
 * Kept in memory: after a restart the next such refusal is told once more.
 */
export class AccountRefusals {
  /** The task each refusal's words were first told for, by account. */
  private readonly told = new Map<string, Map<string, string>>();

  /**
   * Who the first mate first heard these words for on this account, and
   * whether that is this refusal: the first one is recorded now.
   */
  tell(accountId: string, words: string, taskId: string): { first: boolean; teller: string } {
    const told = this.told.get(accountId) ?? new Map<string, string>();
    const teller = told.get(words);
    if (teller !== undefined) return { first: false, teller };
    told.set(words, taskId);
    this.told.set(accountId, told);
    return { first: true, teller: taskId };
  }

  /** A turn on the account went through: its refusals are over. */
  answered(accountId: string): void {
    this.told.delete(accountId);
  }
}
