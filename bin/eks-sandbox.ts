import * as cdk from "aws-cdk-lib";
import { EksSandboxStack } from "../lib/eks-sandbox-stack";

const app = new cdk.App();
new EksSandboxStack(app, "EksSandbox", {
  // env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  trustedOperatorRoleArn: "arn:aws:iam::EXAMPLE:role/OperatorRole", // replace with your own
});
