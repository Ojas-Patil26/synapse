// EventBridge rate(1 hour) -> decay scan (ARCHITECTURE.md flow G).
// Recomputes retention and z-scores for every concept, persists them, and publishes
// one SNS summary when concepts newly became anomalous or crossed R < 0.5.

import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import type { AlertItem } from "../lib/contracts";
import { safeError } from "../lib/data/redact";
import { runDecayScan } from "../lib/data/service";

const MAX_LINES = 40;
let sns: SNSClient | null = null;

function lines(items: AlertItem[]): string[] {
  const shown = items.slice(0, MAX_LINES).map((item) => {
    const z = item.zScore === null ? "n/a" : item.zScore.toFixed(2);
    return `  - ${item.label} (${item.courseName}): retention ${Math.round(item.retention * 100)}%, z-score ${z}`;
  });
  if (items.length > MAX_LINES) shown.push(`  ... and ${items.length - MAX_LINES} more`);
  return shown;
}

/** The message never contains user ids: the topic is an operator channel, not per-user. */
export function buildAlertMessage(newlyAnomalous: AlertItem[], newlyAtRisk: AlertItem[]): string {
  const learners = new Set([...newlyAnomalous, ...newlyAtRisk].map((item) => item.userId)).size;
  const parts = [`Synapse decay scan: ${learners} learner${learners === 1 ? "" : "s"} with new alerts.`];
  if (newlyAnomalous.length > 0) {
    parts.push("", `Forgetting faster than predicted (${newlyAnomalous.length}):`, ...lines(newlyAnomalous));
  }
  if (newlyAtRisk.length > 0) {
    parts.push("", `Dropped below 50% retention (${newlyAtRisk.length}):`, ...lines(newlyAtRisk));
  }
  return parts.join("\n");
}

export const scan = async (): Promise<{
  conceptsScanned: number;
  newlyAnomalous: number;
  newlyAtRisk: number;
  alertSent: boolean;
}> => {
  const result = await runDecayScan();
  const counts = {
    conceptsScanned: result.conceptsScanned,
    newlyAnomalous: result.newlyAnomalous.length,
    newlyAtRisk: result.newlyAtRisk.length,
  };
  console.log(`decayScan ${JSON.stringify(counts)}`);

  let alertSent = false;
  const topicArn = process.env.ALERTS_TOPIC_ARN;
  if (topicArn && counts.newlyAnomalous + counts.newlyAtRisk > 0) {
    try {
      sns ??= new SNSClient({});
      await sns.send(
        new PublishCommand({
          TopicArn: topicArn,
          Subject: "Synapse: concepts need review",
          Message: buildAlertMessage(result.newlyAnomalous, result.newlyAtRisk),
        }),
      );
      alertSent = true;
    } catch (err) {
      // An alert failure must never fail the scan.
      console.error(`decayScan: SNS publish failed: ${safeError(err)}`);
    }
  }
  return { ...counts, alertSent };
};
