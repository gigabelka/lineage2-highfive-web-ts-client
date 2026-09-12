// Message protocol between the main thread (DecodeWorkerClient) and decode.worker.ts.

interface InitMessage {
    type: "init";
}

interface DecodeMessage {
    type: "decode";
    requestId: number;
    sectorName: string;
    settings: GD.LoadSettings_T;
}

type PrecacheMessage_T = {
    type: "precache";
    requestId: number;
    sectorName: string;
    settings: GD.LoadSettings_T;
};

interface FreeMessage {
    type: "free";
    sectorName: string;
}

interface DecodeEnvMessage {
    type: "decodeEnv";
    requestId: number;
}

interface MusicInfoMessage {
    type: "musicInfo";
    requestId: number;
}

/* character/NPC packages are NOT sector-scoped: they must always route to the same pool
   worker, see DecodeWorkerClient.characterWorkerIndex */
interface DecodeCharacterMessage {
    type: "decodeCharacter";
    requestId: number;
    settings: GD.LoadSettings_T;
    charIndex: number;
    faceVariant: number;
    hairVariant: number;
    hairColour: number;
    armor: GD.ICharacterArmorSelection;
    includeAnimations: boolean;
}

interface DecodeSkeletalMeshMessage {
    type: "decodeSkeletalMesh";
    requestId: number;
    settings: GD.LoadSettings_T;
    packageName: string;
    meshName: string;
    /* script-bound meshes need the UnrealScript class graph (Phase 4) */
    scriptClassPath: string;
    texturePaths: string[];
    /* non-null carries the resolved Npcgrp.dat id through to the decoded actor */
    npcId: number | null;
    includeAnimations: boolean;
}

interface CharGroupsMessage {
    type: "charGroups";
    requestId: number;
}

/* NPC catalog lookup is NOT sector-scoped either - routes to the same character worker as
   decodeCharacter/getCharGroups, see DecodeWorkerClient.characterWorkerIndex */
interface ResolveNpcMessage {
    type: "resolveNpc";
    requestId: number;
    selector: string | number;
}

interface PrecacheCharactersMessage {
    type: "precacheCharacters";
    requestId: number;
    settings: GD.LoadSettings_T;
}

interface ClientConfigMessage {
    type: "clientConfig";
    requestId: number;
}

type MainToWorkerMessage = InitMessage | DecodeMessage | PrecacheMessage_T | FreeMessage | DecodeEnvMessage | MusicInfoMessage | DecodeCharacterMessage | DecodeSkeletalMeshMessage | CharGroupsMessage | ResolveNpcMessage | PrecacheCharactersMessage | ClientConfigMessage;

interface ReadyMessage {
    type: "ready";
}

interface InitErrorMessage {
    type: "initError";
    message: string;
}

interface DecodedMessage {
    type: "decoded";
    requestId: number;
    buffer: ArrayBuffer;
}

type PrecacheResult_T = { cached: boolean, bytes: number };

type PrecachedMessage_T = {
    type: "precached";
    requestId: number;
    result: PrecacheResult_T;
};

interface DecodeErrorMessage {
    type: "decodeError";
    requestId: number;
    message: string;
    stack?: string; // worker-side stack for the main thread console
}

interface EnvDecodedMessage {
    type: "envDecoded";
    requestId: number;
    info: any; // plain env decode info (UConfigEnv.getDecodeInfo)
}

interface MusicInfoDecodedMessage {
    type: "musicInfoDecoded";
    requestId: number;
    music: Record<number, string[]>; // music id -> package paths
}

interface CharGroupsDecodedMessage {
    type: "charGroupsDecoded";
    requestId: number;
    groups: GD.ICharacterGroup[];
}

interface NpcResolvedMessage {
    type: "npcResolved";
    requestId: number;
    npc: GD.INpcDefinition;
}

interface CharactersPrecachedMessage {
    type: "charactersPrecached";
    requestId: number;
}

interface ClientConfig_T {
    userConfig: GA.IUserConfig;
    warriorAnimations: Record<string, GA.WarriorAnimations_T>;
}

interface ClientConfigDecodedMessage {
    type: "clientConfigDecoded";
    requestId: number;
    config: ClientConfig_T;
}

type WorkerToMainMessage = ReadyMessage | InitErrorMessage | DecodedMessage | PrecachedMessage_T | DecodeErrorMessage | EnvDecodedMessage | MusicInfoDecodedMessage | CharGroupsDecodedMessage | NpcResolvedMessage | CharactersPrecachedMessage | ClientConfigDecodedMessage;

export type { MainToWorkerMessage, WorkerToMainMessage, InitMessage, DecodeMessage, PrecacheMessage_T, PrecacheResult_T, PrecachedMessage_T, FreeMessage, DecodeEnvMessage, MusicInfoMessage, DecodeCharacterMessage, DecodeSkeletalMeshMessage, CharGroupsMessage, ResolveNpcMessage, PrecacheCharactersMessage, ClientConfigMessage, ReadyMessage, InitErrorMessage, DecodedMessage, DecodeErrorMessage, EnvDecodedMessage, MusicInfoDecodedMessage, CharGroupsDecodedMessage, NpcResolvedMessage, CharactersPrecachedMessage, ClientConfigDecodedMessage, ClientConfig_T };
