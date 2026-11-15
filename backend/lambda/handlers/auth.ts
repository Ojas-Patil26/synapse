import type { PreSignUpTriggerEvent } from "aws-lambda";

/**
 * Cognito pre-sign-up trigger. By default a new account must confirm its email with a code (Cognito
 * sends it). Set AUTO_CONFIRM_SIGNUPS=true at deploy time to confirm every sign-up at once instead,
 * which skips the email step (useful for a demo or if email delivery is a problem).
 */
export const preSignUp = async (event: PreSignUpTriggerEvent): Promise<PreSignUpTriggerEvent> => {
  if (process.env.AUTO_CONFIRM_SIGNUPS === "true") {
    event.response.autoConfirmUser = true;
    if (event.request?.userAttributes?.email) event.response.autoVerifyEmail = true;
  }
  return event;
};
