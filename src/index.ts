// Public surface of the competition engine package (for `tsup` builds and embedding/tests).
export { loadCompetitionConfig, createDataLayer } from './config.js';
export type { CompetitionConfig, EvalEngineLookup, ResolvedEvalEngine } from './config.js';
export { AuthManager } from './auth.js';
export { createNotifier, SOCKET_AUTH_MESSAGE } from './notify.js';
export type { AgentNotifier, CompetitionJobNotice, SocketNotifier } from './notify.js';
export { CompetitionEngine, parseLifetimeMs } from './engine.js';
export type {
    CompetitionStatus,
    CompetitionSummary,
    LeaderboardRow,
    CompetitionRules,
    CompetitionDetail,
} from './engine.js';
export { CompetitionChain } from './onchain.js';
export { Store } from './store.js';
export type { CompetitionBinding, CompetitionJobRecord } from './store.js';
export {
    EventWatcher,
    decodeAgentJoined,
    decodeCompetitionCreated,
} from './events.js';
export {
    buildPayload,
    buildPortfolioPayload,
    callEvalEngine,
    verifyScoreSignature,
    verifyMetricSignature,
    classifyEvalError,
} from './evaluation.js';
