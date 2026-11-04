/** Dormant host entry point. Importing this module starts no worker, provider call or application. */
export { TaskRuntime, type TaskRuntimeOptions } from '../tasks/runtime.js';
export { TaskController, workerInput, type Delivery, type RevisionIdentity } from '../tasks/controller.js';
export { createRegistry, type TaskTool } from '../tasks/tools.js';
export { connectorExecutor, configuredCompanyTools, type BoundConnector, type ExistingExecutors } from '../tasks/connectors.js';
export { createModelPort, DEFAULT_WORKER_MODEL, type ModelRole, type RoleModels } from '../tasks/model.js';
export type { Authority, AuthorizationRequest, Identity } from '../tasks/authority.js';
