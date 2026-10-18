/**
 * What the sign-in form's error box says. The server answers "Invalid email or
 * password" for a wrong password AND for an account created through Google
 * (which has no password at all) and gives no signal telling them apart, so the
 * Google hint is held back until it can plausibly be the cause: Google sign-in
 * is offered on this server and the same email has failed at least twice.
 */
export interface SignInErrorCopy {
  message: string;
  hint: string | null;
}

const INVALID_CREDENTIALS = /invalid email or password/i;

export const GOOGLE_NO_PASSWORD_HINT =
  "Usually sign in with Google? Use Continue with Google, or reset your password.";

/** Accounts are created and disabled by the server owner (admin panel). */
export const ACCOUNT_DISABLED_COPY =
  "This account is disabled. Ask whoever runs this server to enable it again.";
export const NO_ACCOUNT_COPY =
  "There is no account for this address on this server. Ask whoever runs it to create one for you.";

export function isInvalidCredentials(error: string): boolean {
  return INVALID_CREDENTIALS.test(error);
}

export function signInErrorCopy(
  error: string,
  opts: { googleEnabled: boolean; attempts: number },
): SignInErrorCopy {
  if (/account_disabled/i.test(error)) return { message: ACCOUNT_DISABLED_COPY, hint: null };
  if (/signup_disabled|sign up is not enabled/i.test(error)) return { message: NO_ACCOUNT_COPY, hint: null };
  if (!isInvalidCredentials(error)) return { message: error, hint: null };
  return {
    message: "Invalid email or password.",
    hint: opts.googleEnabled && opts.attempts >= 2 ? GOOGLE_NO_PASSWORD_HINT : null,
  };
}
