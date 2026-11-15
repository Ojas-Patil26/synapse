import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lambda/lib/data/service");
vi.mock("../../lambda/lib/aws/s3");
vi.mock("../../lambda/lib/aws/cognito");
vi.mock("../../lambda/lib/supermemory");

import { deleteAccount } from "../../lambda/handlers/account";
import { deleteCognitoUser } from "../../lambda/lib/aws/cognito";
import { deleteUserUploads } from "../../lambda/lib/aws/s3";
import * as data from "../../lambda/lib/data/service";
import { deleteLearnerData } from "../../lambda/lib/supermemory";
import { USER, makeEvent, parse } from "./helpers";

describe("DELETE /account", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(data.deleteAllUserData).mockResolvedValue({ documents: 7, reviewEvents: 12 });
    vi.mocked(deleteUserUploads).mockResolvedValue(3);
    vi.mocked(deleteLearnerData).mockResolvedValue(true);
    vi.mocked(deleteCognitoUser).mockResolvedValue(undefined);
  });

  it("removes data, uploads and the learner profile for the caller, then the login last", async () => {
    const res = await deleteAccount(makeEvent({}));
    expect(res.statusCode).toBe(200);
    expect(parse(res)).toEqual({ deleted: true, documents: 7, reviewEvents: 12, uploads: 3, profileRemoved: true });
    for (const fn of [data.deleteAllUserData, deleteUserUploads, deleteLearnerData, deleteCognitoUser]) {
      expect(fn).toHaveBeenCalledWith(USER);
    }
    expect(vi.mocked(deleteCognitoUser).mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(deleteLearnerData).mock.invocationCallOrder[0],
    );
  });

  it("keeps the login when an earlier step fails, so the request can be repeated", async () => {
    vi.mocked(deleteUserUploads).mockRejectedValue(new Error("s3 down"));
    const res = await deleteAccount(makeEvent({}));
    expect(res.statusCode).toBe(500);
    expect(deleteCognitoUser).not.toHaveBeenCalled();
  });
});
