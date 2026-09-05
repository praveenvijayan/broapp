/** The contract's type, named once so components do not each re-derive it. */
import type { contract } from './contract.ts';

export type AppContract = typeof contract;
