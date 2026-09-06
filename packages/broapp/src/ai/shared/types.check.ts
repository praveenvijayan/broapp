/**
 * Type-level proof that the contract and the hand-written types agree.
 *
 * Nothing here runs. It exists so that changing a schema in `contract.ts`
 * without changing the matching interface in `types.ts` fails `tsc` instead of
 * failing later, in the browser, as a shape that is almost right.
 */
import type { OperationInput, OperationOutput, StreamEvent } from '../../shared/contract.ts';
import type { AiContract } from './contract.ts';
import type { AiSettings, BroappModel, ChatEvent, ProviderInfo } from './types.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

const settingsMatch: Equal<OperationOutput<AiContract, 'ai.settings.get'>, AiSettings> = true;
void settingsMatch;

const settingsUpdateReturnsSettings: Equal<
  OperationOutput<AiContract, 'ai.settings.update'>,
  AiSettings
> = true;
void settingsUpdateReturnsSettings;

const modelMatch: Equal<
  OperationOutput<AiContract, 'ai.models.list'>['models'][number],
  BroappModel
> = true;
void modelMatch;

const providerMatch: Equal<
  OperationOutput<AiContract, 'ai.providers.list'>['providers'][number],
  ProviderInfo
> = true;
void providerMatch;

const chatEventMatch: Equal<StreamEvent<AiContract, 'ai.chat'>, ChatEvent> = true;
void chatEventMatch;

// The update route is the only one that takes a partial: every field optional,
// so a browser can change one setting without restating the rest.
const updateAcceptsNothing: OperationInput<AiContract, 'ai.settings.update'> = {};
void updateAcceptsNothing;
