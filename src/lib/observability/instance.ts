import { hostname } from "node:os";

/**
 * Which copy of the application this is, and whether it should be sent traffic.
 *
 * Behind one process neither question is interesting. Behind several, both
 * become the difference between an operator who can see what is happening and
 * one reading a log where two replicas are indistinguishable — "the error is on
 * some instance" is not an answer anybody can act on.
 *
 * Everything here is per-process on purpose. Instance identity that lived in a
 * shared store would not be instance identity.
 */

/**
 * A stable name for this process.
 *
 * The container's hostname is the right default: an orchestrator already sets
 * it to something meaningful, and it is what appears in `docker ps`. INSTANCE_ID
 * overrides it for deployments where the hostname is not useful.
 */
export const INSTANCE_ID: string =
  process.env.INSTANCE_ID?.trim() || hostname() || "unknown";

/**
 * When this process started, as a Unix timestamp.
 *
 * Distinguishes "this replica restarted" from "the whole service restarted",
 * which is the first thing worth knowing when counters reset.
 */
export const STARTED_AT: number = Math.floor(Date.now() / 1000);

/**
 * Lifecycle state.
 *
 * `draining` is the state between a shutdown signal arriving and the process
 * actually exiting. It exists so a load balancer can be told to stop sending
 * new requests *before* the process stops being able to serve them — without
 * it, a rolling deploy drops whatever was in flight, and a shopkeeper posting
 * an invoice sees a failure caused by nothing they did.
 */
let draining = false;

export function isDraining(): boolean {
  return draining;
}

/** Marks this instance as no longer accepting new traffic. One way only. */
export function beginDraining(): void {
  draining = true;
}

/** Test seam. Production never returns an instance to service. */
export function resetLifecycleForTests(): void {
  draining = false;
}
