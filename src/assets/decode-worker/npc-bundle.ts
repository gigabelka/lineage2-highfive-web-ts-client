export const NPC_MONSTERS_BUNDLE = "npc_monsters";
export const NPC_NPCS_BUNDLE = "npc_npcs";

/* every LineageMonsters*.ukx ships into "npc_monsters", the LineageNpcs* and LineageDecos
   packages into "npc_npcs" - one bundle per package group keeps the per-worker package
   refcount low, since a bundle decodes every mesh of its group in one pass. */
const MONSTER_PACKAGES = new Set([
    "lineagemonsters",
    "lineagemonsters2",
    "lineagemonsters3",
    "lineagemonsters4",
    "lineagemonsters5",
    "lineagemonsters6",
]);

const NPC_PACKAGES = new Set([
    "lineagenpcs",
    "lineagenpcs2",
    "lineagenpcsev",
    "lineagedecos",
]);

export function getNpcBundleName(packageName: string): string {
    const name = packageName.toLowerCase();

    if (MONSTER_PACKAGES.has(name)) return NPC_MONSTERS_BUNDLE;
    if (NPC_PACKAGES.has(name)) return NPC_NPCS_BUNDLE;

    throw new Error(`NPC mesh package '${packageName}' has no bundle.`);
}

export function isNpcMeshPackage(packageName: string): boolean {
    const name = packageName.toLowerCase();

    return MONSTER_PACKAGES.has(name) || NPC_PACKAGES.has(name);
}

export default getNpcBundleName;
