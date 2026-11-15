// Deletes a user from the Cognito user pool (used by account deletion).
import { AdminDeleteUserCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";

let client: CognitoIdentityProviderClient | null = null;

export async function deleteCognitoUser(userId: string): Promise<void> {
  const poolId = process.env.USER_POOL_ID;
  if (!poolId) throw new Error("USER_POOL_ID is not set");
  client ??= new CognitoIdentityProviderClient({});
  // With email sign-in the pool's internal username is the user's sub.
  await client.send(new AdminDeleteUserCommand({ UserPoolId: poolId, Username: userId }));
}
