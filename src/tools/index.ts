import type { Capability } from "../types.ts";
import { colimaDisk } from "./colima-disk.ts";
import { projects } from "./projects.ts";
import { projectStatus } from "./project-status.ts";
import { projectCheck } from "./project-check.ts";
import { projectHealth } from "./project-health.ts";
import { memory } from "./memory.ts";

// Every tool module appends its capability here. The registry spreads this array,
// so adding a feature is one module + one entry — nothing else changes.
export const TOOLS: Capability[] = [colimaDisk, projects, projectStatus, projectCheck, projectHealth, memory];
