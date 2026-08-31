#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { devParameter } from "./parameter";
import { createBillingMcpStack } from "./stacks/billing-mcp-stack";

const app = new App();

createBillingMcpStack(app, `BillingMcpStack-${devParameter.envName}`, devParameter);
