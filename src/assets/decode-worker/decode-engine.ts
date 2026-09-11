import AssetLoader from "@client/assets/asset-loader";
import UConfigEnv from "@unreal/conf-files/un-conf-env";
import UConfigHair from "@unreal/conf-files/un-conf-hair";
import UConfigWarrior, {
  WarriorAnimations_T,
} from "@unreal/conf-files/un-conf-warrior";
import UDataFile from "@unreal/datafile/un-datafile";
import {
  SCHEMA_MUSICINFO_DAT,
  SCHEMA_CHARGRP_DAT,
  CHARGRP_RECORD_COUNT,
  SCHEMA_ARMORGRP_DAT,
  SCHEMA_ITEMNAME_E_DAT,
  CHARACTER_ARMOR_GROUPS,
  CHARACTER_ARMOR_SLOTS,
} from "@unreal/datafile/schema/schema-types";
import { getUserConfig } from "@unreal/conf-files/un-conf-system";
import DecodeLibrary from "@unreal/decode-library";
import DecodeLibraryBuilder from "@unreal/decode-library-builder";
import { buildStaticMeshBatchData } from "@client/assets/decoders/batch-data";
import { convertDDSMaterialsToRGBA } from "@client/assets/decoders/dxt-decode";
import buildDecodeLibrary from "./build-decode-library";
import prepareLibraryForTransfer from "./collect-transferables";
import {
  hasCachedLibrary,
  loadCachedLibrary,
  loadCachedLibraryBuffer,
  storeCachedLibrary,
  storeCachedLibraryDurable,
  storeCachedLibraryBufferDurable,
  sweepDecodeCache,
  refreshSoundBlobUris,
} from "./decode-cache";
import { serializeLibrary, deserializeLibrary } from "./library-serializer";
import type { PrecacheResult_T, ClientConfig_T } from "./decode-protocol";

type BinarySector_T = { buffer: ArrayBuffer; fromCache: boolean };

/* the character bundle a cached assembly was built from - the parts of it a later
   decodeCharacter call re-assembles into a fresh library */
type CharacterBundle_T = {
  name: string;
  animationSet: string;
  animations: Record<string, GD.IKeyframeDecodeInfo_T[]>;
  animationSequences: Record<string, GD.IAnimationSequenceDecodeInfo>;
  animationNotifies: Record<string, GD.IAnimationNotifyDecodeInfo[]>;
  skinNotifies: Record<string, GD.ISkinNotifyDecodeInfo>;
  meshes: Record<string, string>;
  materials: Record<string, string>;
};

type CharacterHairPieces_T = Map<number, Map<number, [string, string][]>>;
type CharacterPartPaths_T = [string, string];
type CachedBundle_T = { library: DecodeLibrary };

/* ULodMesh.Version values that make a hair mesh simulate (retail NCBoneSimul switch) */
const dynamicHairTypes = new Set([2, 5, 6, 7, 9]);

function characterBundleCacheName(charIndex: number, name: string): string {
  return `character_${charIndex}_${name}`.replace(/[^\w.-]/g, "_");
}

/* a character assembly references materials and material modifiers by uuid; carrying an
   assembled part into a new library means carrying everything it points at */
function copyCharacterMaterial(
  target: DecodeLibrary,
  source: DecodeLibrary,
  root: string,
) {
  const seenMaterials = new Set<string>();
  const seenModifiers = new Set<string>();

  function copyReferences(value: any) {
    if (typeof value === "string") {
      if (value in source.materials) copyMaterial(value);
      if (value in source.materialModifiers) copyModifier(value);
      return;
    }

    if (
      !value ||
      typeof value !== "object" ||
      value instanceof ArrayBuffer ||
      ArrayBuffer.isView(value)
    )
      return;

    if (Array.isArray(value)) {
      for (const entry of value) copyReferences(entry);
      return;
    }

    for (const entry of Object.values(value)) copyReferences(entry);
  }

  function copyMaterial(uuid: string) {
    if (seenMaterials.has(uuid)) return;

    const info = source.materials[uuid];

    if (!info)
      throw new Error(`Character material '${uuid}' not found in its bundle.`);

    seenMaterials.add(uuid);
    target.materials[uuid] = Object.assign({}, info);
    copyReferences(info);
  }

  function copyModifier(uuid: string) {
    if (seenModifiers.has(uuid)) return;

    const info = source.materialModifiers[uuid];

    if (!info)
      throw new Error(
        `Character material modifier '${uuid}' not found in its bundle.`,
      );

    seenModifiers.add(uuid);
    target.materialModifiers[uuid] = Object.assign({}, info);
    copyReferences(info);
  }

  copyMaterial(root);
}

/* sound notify entries name sounds by USound object name; the assembling library needs
   the decoded blobs themselves, they are keyed by the same name in soundBlobCache */
function copyAnimationSounds(
  target: DecodeLibrary,
  source: DecodeLibrary,
  animationNotifies: Record<string, GD.IAnimationNotifyDecodeInfo[]>,
): void {
  function copySound(name: string): void {
    if (!name || target.soundBlobCache.has(name)) return;

    const sound = source.soundBlobCache.get(name);

    if (!sound)
      throw new Error(`Asset bundle has no decoded sound '${name}'.`);

    target.soundBlobCache.set(name, sound);
  }

  const soundsToCopy = [
    "defaultWalkSounds",
    "defaultRunSounds",
    "grassWalkSounds",
    "grassRunSounds",
    "waterWalkSounds",
    "waterRunSounds",
    "defaultActorWalkSounds",
    "defaultActorRunSounds",
  ] as const;

  for (const notifications of Object.values(animationNotifies)) {
    for (const notify of notifications) {
      const object = notify.object;

      if (!object) continue;

      if (object.type === "swimSound") {
        /* the swim profile is filled in by pullAnimationNotifyAssets, still null here */
        if (object.surface)
          for (const name of object.surface.sounds) copySound(name);
        if (object.underwater)
          for (const name of object.underwater.sounds) copySound(name);
        continue;
      }

      if (object.type !== "sound") continue;

      copySound(object.sound);

      for (const soundKey of soundsToCopy)
        for (const name of object[soundKey]) copySound(name);
    }
  }
}

function splitObjectPath(path: string): [string, string] {
  const index = path.indexOf(".");

  return [path.slice(0, index), path.slice(index + 1)];
}

/* every body-part material a skin notify can switch to, keyed by its skinIndex */
function getSkinNotifyIndices(
  skinNotifies: Record<string, GD.ISkinNotifyDecodeInfo>,
): Set<number> {
  const indices = new Set<number>();

  function addTimeline(timeline: GD.ISkinNotifyEntryDecodeInfo[]): void {
    for (const entry of timeline) {
      if (entry.skinIndex < 0)
        throw new Error(`Invalid skin notify index '${entry.skinIndex}'.`);

      indices.add(entry.skinIndex);
    }
  }

  for (const info of Object.values(skinNotifies)) {
    if (info.mode === "grouped") {
      for (const group of info.groups) addTimeline(group.timeline);
    } else addTimeline(info.timeline);
  }

  indices.add(0);

  return indices;
}

/* the skin-notify variants of a body-part material ship as `<name>_f1`, `<name>_f2`, … */
function getSkinMaterialPath(path: string, index: number): string {
  if (index === 0) return path;

  const [packageName, objectName] = splitObjectPath(path);

  if (!/_f$/i.test(objectName))
    throw new Error(`Skin notify base material '${path}' does not end in '_f'.`);

  return `${packageName}.${objectName}${String.fromCharCode(48 + index)}`;
}

function getCharacterRow(
  rows: Record<string, any>[],
  charIndex: number,
): Record<string, any> {
  const row = rows[charIndex];

  if (!row || row.face_mesh.length === 0)
    throw new Error(`Character group '${charIndex}' does not exist.`);

  return row;
}

/* the face mesh names the armour column group: `MHumanFighter_m00_f` -> mfighter */
function getCharacterArmorGroup(row: Record<string, any>): string {
  const name = splitObjectPath(row.face_mesh[0] as string)[1]
    .replace(/_m\d+_f$/, "")
    .toLowerCase();
  const group = CHARACTER_ARMOR_GROUPS[name];

  if (!group)
    throw new Error(`Character armor group '${name}' does not exist.`);

  return group;
}

function getCharacterArmorPaths(
  row: Record<string, any>,
  armor: Record<string, any>,
): CharacterPartPaths_T[] {
  const group = getCharacterArmorGroup(row);
  const meshes = armor[`${group}_mesh`] as string[];
  const textures = armor[`${group}_texture`] as string[];
  const additionalMeshes = armor[`${group}_additional_mesh`] as string[];
  const additionalTextures = armor[`${group}_additional_texture`] as string[];

  if (meshes.length !== textures.length)
    throw new Error(
      `Armor '${armor.id}' has ${meshes.length} meshes and ${textures.length} textures for '${group}'.`,
    );
  if (additionalMeshes.length !== additionalTextures.length)
    throw new Error(
      `Armor '${armor.id}' has ${additionalMeshes.length} additional meshes and ${additionalTextures.length} additional textures for '${group}'.`,
    );

  return [
    ...meshes.map(
      (mesh, i) => [mesh, textures[i]] as CharacterPartPaths_T,
    ),
    ...additionalMeshes.map(
      (mesh, i) => [mesh, additionalTextures[i]] as CharacterPartPaths_T,
    ),
  ].filter((part) => part[0] && part[1]);
}

function getCharacterArmorLabel(
  armor: Record<string, any>,
  itemNames: Map<number, Record<string, any>>,
): string {
  const item = itemNames.get(armor.id);

  if (!item || !item.name)
    throw new Error(`Armor '${armor.id}' has no item name.`);

  const name = (item.name as string).trim();
  const addName = (item.add_name as string).trim();

  return addName ? `${name} ${addName}` : name;
}

/* the four naked body parts in chargrp.dat order, replaced by armour when it names the slot */
function resolveCharacterPartPaths(
  row: Record<string, any>,
  hairPieces: CharacterHairPieces_T,
  armorRows: Record<string, any>[],
  faceVariant: number,
  hairVariant: number,
  hairColour: number,
  armor: GD.ICharacterArmorSelection,
): [string[], string[]] {
  const faceMesh = row.face_mesh[0] as string;
  const faceTexture = row.face_tex[
    faceVariant % row.face_tex.length
  ] as string;
  const style = hairPieces.has(hairVariant)
    ? hairVariant
    : [...hairPieces.keys()].sort((a, b) => a - b)[0];
  const colours = hairPieces.get(style);
  const pieces = colours.get(
    colours.has(hairColour)
      ? hairColour
      : [...colours.keys()].sort((a, b) => a - b)[0],
  );
  const bodyParts = (row.body_mesh as string[]).map(
    (mesh, i) => [[mesh, row.body_tex[i]]] as CharacterPartPaths_T[],
  );
  const bodyIndices: Record<string, number> = { u: 0, l: 1, g: 2, b: 3 };

  for (const slot of Object.keys(CHARACTER_ARMOR_SLOTS)) {
    const id = armor[slot as keyof GD.ICharacterArmorSelection];

    if (!id) continue;

    const armorRow = armorRows.find((row) => row.id === id);

    if (!armorRow) throw new Error(`Armor '${id}' does not exist.`);
    if (
      armorRow.body_part !==
      CHARACTER_ARMOR_SLOTS[slot as keyof typeof CHARACTER_ARMOR_SLOTS]
    )
      throw new Error(`Armor '${id}' does not fit '${slot}'.`);

    const cleared = new Set<number>();

    for (const part of getCharacterArmorPaths(row, armorRow)) {
      const match = /_([ulgb])$/i.exec(splitObjectPath(part[0])[1]);
      const index = match
        ? bodyIndices[match[1].toLowerCase()]
        : Object.keys(CHARACTER_ARMOR_SLOTS).indexOf(slot);

      if (!cleared.has(index)) {
        bodyParts[index] = [];
        cleared.add(index);
      }

      bodyParts[index].push(part);
    }
  }

  const body = bodyParts.flat();

  return [
    [
      faceMesh,
      ...pieces.map((piece) => piece[0]),
      ...body.map((piece) => piece[0]),
    ] as string[],
    [
      faceTexture,
      ...pieces.map((piece) => piece[1]),
      ...body.map((piece) => piece[1]),
    ] as string[],
  ];
}

/**
 * Owns an AssetLoader and runs the full sector decode - deserialization, decode-info
 * generation, batch merging and DXT->RGBA conversion. Used by decode.worker.ts (message
 * driven, its own webpack bundle) and directly by DecodeWorkerClient on the main thread
 * when its pool size is 0, so a decode can be stepped through in regular devtools
 * instead of a worker context.
 */
class DecodeEngine {
  protected assetLoader: AssetLoader = null;
  protected hasSweptCache = false;
  /* loose .ogg music tracks: lowercased file name -> server URL, straight from asset-list.json */
  protected musicAssets: Record<string, string> = {};
  /* chargrp.dat / armorgrp.dat / itemname-e.dat rows */
  protected cacheCharGrpRows: Record<string, any>[] = null;
  protected cacheArmorGrpRows: Record<string, any>[] = null;
  protected cacheItemNameRows: Record<string, any>[] = null;
  /* character index -> the assembled naked-body bundle, filled by precacheCharacters and by
     the first decodeCharacter of that index (in-memory only - see precacheCharacters) */
  protected cacheCharacterBundles = new Map<number, CachedBundle_T>();
  protected cacheCharacterHairPieces = new Map<number, CharacterHairPieces_T>();
  protected cacheHairConfig: UConfigHair = null;

  protected async sweepCache(settings: GD.LoadSettings_T): Promise<void> {
    if (this.hasSweptCache) return;

    await sweepDecodeCache(settings);
    this.hasSweptCache = true;
  }

  /* system/l2.ini defaults overridden by whatever Option.ini defines */
  public async decodeClientConfig(): Promise<ClientConfig_T> {
    const [userConfig, warriorFile] = await Promise.all([
      getUserConfig(),
      new UConfigWarrior("/assets/system/LineageWarrior.int").decode(),
    ]);
    const warriorConfig = await warriorFile.load();
    const warriorAnimations: Record<string, WarriorAnimations_T> = {};

    for (const className of warriorConfig.getClassNames())
      warriorAnimations[className] = warriorConfig.getAnimations(className);

    return { userConfig, warriorAnimations };
  }

  protected async fetchSkeletalMesh(path: string): Promise<GA.USkeletalMesh> {
    const [packageName, objectName] = splitObjectPath(path);
    const pkg = await this.assetLoader.using(
      this.assetLoader.getPackage(packageName, "Animation") as C.APackage,
      { neverUnload: true },
    );
    const lowerName = objectName.toLowerCase();
    const entry = pkg.exportGroups.SkeletalMesh.find(
      (entry) => (entry.export.objectName as string).toLowerCase() === lowerName,
    );

    if (!entry)
      throw new Error(
        `Skeletal mesh '${objectName}' not found in '${packageName}'.`,
      );

    return pkg.fetchObject<GA.USkeletalMesh>(entry.index + 1);
  }

  protected async fetchCharacterMaterial(path: string): Promise<GA.UMaterial> {
    const [packageName, objectName] = splitObjectPath(path);
    const pkg = await this.assetLoader.using(
      this.assetLoader.getPackage(packageName, "Texture") as C.APackage,
      { neverUnload: true },
    );
    const lowerName = objectName.toLowerCase();
    const entry = pkg.exports.find(
      (entry) => (entry.objectName as string).toLowerCase() === lowerName,
    );

    if (!entry)
      throw new Error(`Material '${objectName}' not found in '${packageName}'.`);

    return pkg.fetchObject<GA.UMaterial>(entry.index + 1);
  }

  /* the skin-notify variants of the face/body material, decoded alongside it */
  protected async pullCharacterSkinMaterials(
    builder: GD.DecodeLibraryBuilder,
    skinNotifies: Record<string, GD.ISkinNotifyDecodeInfo>,
    basePath: string,
    baseMaterial: string,
  ): Promise<Record<number, string>> {
    const materials: Record<number, string> = { 0: baseMaterial };

    for (const index of getSkinNotifyIndices(skinNotifies)) {
      if (index === 0) continue;

      const path = getSkinMaterialPath(basePath, index);

      materials[index] = builder.pullMaterial(
        await this.fetchCharacterMaterial(path),
      );
    }

    return materials;
  }

  protected async decodeCharGrp(): Promise<Record<string, any>[]> {
    if (this.cacheCharGrpRows) return this.cacheCharGrpRows;

    const file = await new UDataFile(
      SCHEMA_CHARGRP_DAT,
      "/assets/system/chargrp.dat",
      CHARGRP_RECORD_COUNT,
    )
      .asReadable()
      .decode();

    this.cacheCharGrpRows = file.datarows;

    return this.cacheCharGrpRows;
  }

  protected async decodeArmorGrp(): Promise<Record<string, any>[]> {
    if (this.cacheArmorGrpRows) return this.cacheArmorGrpRows;

    const file = await new UDataFile(
      SCHEMA_ARMORGRP_DAT,
      "/assets/system/armorgrp.dat",
    )
      .asReadable()
      .decode();

    this.cacheArmorGrpRows = file.datarows;

    return this.cacheArmorGrpRows;
  }

  protected async decodeItemNames(): Promise<Record<string, any>[]> {
    if (this.cacheItemNameRows) return this.cacheItemNameRows;

    const file = await new UDataFile(
      SCHEMA_ITEMNAME_E_DAT,
      "/assets/system/itemname-e.dat",
    )
      .asReadable()
      .decode();

    this.cacheItemNameRows = file.datarows;

    return this.cacheItemNameRows;
  }

  /* hair carries its own style and colour axes - the face texture only ever names the head */
  protected async characterHairPieces(
    charIndex: number,
  ): Promise<CharacterHairPieces_T> {
    if (this.cacheCharacterHairPieces.has(charIndex))
      return this.cacheCharacterHairPieces.get(charIndex)!;

    const rows = await this.decodeCharGrp();
    const row = getCharacterRow(rows, charIndex);
    const [packageName, faceName] = splitObjectPath(row.face_mesh[0] as string);
    const [texturePackage] = splitObjectPath(row.face_tex[0] as string);
    /* reading the export table only, no ref-count */
    const pkg = await this.assetLoader.load(
      this.assetLoader.getPackage(packageName, "Animation") as C.APackage,
    );
    const textures = await this.characterTextureNames(
      row.face_tex[0] as string,
    );
    const pattern = new RegExp(
      `^${faceName.replace(/_m\d+_f$/, "").toLowerCase()}_m(\\d+)_m00_(ah|bh)$`,
    );
    const styles = new Map<number, Map<number, [string, string][]>>();

    for (const entry of pkg.exportGroups.SkeletalMesh) {
      const name = entry.export.objectName;
      const match = pattern.exec(name.toLowerCase());

      if (!match) continue;

      const style = parseInt(match[1], 10);
      const texturePattern = new RegExp(
        `^${name.replace(/_m00_(ah|bh)$/i, "_t(\\d+)_m00_$1")}$`,
        "i",
      );

      for (const texture of textures) {
        const textureMatch = texturePattern.exec(texture);

        // every style ships a mesh for both pieces, but only the pieces it actually wears get a texture
        if (!textureMatch) continue;

        const colour = parseInt(textureMatch[1], 10);

        if (!styles.has(style)) styles.set(style, new Map());

        const colours = styles.get(style);

        if (!colours.has(colour)) colours.set(colour, []);

        colours
          .get(colour)
          .push([`${packageName}.${name}`, `${texturePackage}.${texture}`]);
      }
    }

    this.cacheCharacterHairPieces.set(charIndex, styles);

    return styles;
  }

  protected async characterTextureNames(faceTexture: string): Promise<string[]> {
    const pkg = await this.assetLoader.load(
      this.assetLoader.getPackage(splitObjectPath(faceTexture)[0], "Texture") as C.APackage,
    );

    return pkg.exports.map((entry) => entry.objectName as string);
  }

  protected async characterPartPaths(
    charIndex: number,
    faceVariant: number,
    hairVariant: number,
    hairColour: number,
    armor: GD.ICharacterArmorSelection,
  ): Promise<[string[], string[]]> {
    const rows = await this.decodeCharGrp();
    const row = getCharacterRow(rows, charIndex);
    const hairPieces = await this.characterHairPieces(charIndex);
    const armorRows = await this.decodeArmorGrp();

    return resolveCharacterPartPaths(
      row,
      hairPieces,
      armorRows,
      faceVariant,
      hairVariant,
      hairColour,
      armor,
    );
  }

  /* system/Hair.int is keyed by the hair mesh's own section, or by `<hairMesh>.<bodyMesh>`
     when the behaviour depends on the body it sits on */
  protected async applyCharacterHairConfig(
    infos: GD.ISkinnedMeshObjectDecodeInfo[],
    meshPaths: string[],
  ): Promise<void> {
    if (!infos.some((info) => dynamicHairTypes.has(info.boneSimulationType)))
      return;

    const bodyPath = meshPaths.find((path) =>
      /_u$/i.test(splitObjectPath(path)[1]),
    );

    if (!bodyPath)
      throw new Error(`Character assembly has dynamic hair but no upper-body mesh.`);

    if (!this.cacheHairConfig) {
      const config = await new UConfigHair("/assets/system/Hair.int").decode();

      this.cacheHairConfig = config.load();
    }

    const bodyName = splitObjectPath(bodyPath)[1];

    for (let i = 0, len = infos.length; i < len; i++) {
      const info = infos[i];

      if (!dynamicHairTypes.has(info.boneSimulationType)) continue;

      const hairName = splitObjectPath(meshPaths[i])[1];

      info.dynamicHair = {
        type: info.boneSimulationType,
        config: this.cacheHairConfig.getDecodeInfo(hairName, bodyName),
      };
    }
  }

  /* chargrp.dat -> the playable groups and, per group, its face/hair/armour options */
  public async decodeCharGroups(): Promise<GD.ICharacterGroup[]> {
    const rows = await this.decodeCharGrp();
    const armorRows = await this.decodeArmorGrp();
    const itemNames = new Map(
      (await this.decodeItemNames()).map((item) => [item.id as number, item]),
    );
    const groups: GD.ICharacterGroup[] = [];

    for (let index = 0, len = rows.length; index < len; index++) {
      const row = rows[index];

      if (row.face_mesh.length === 0) {
        if (index !== CHARGRP_RECORD_COUNT - 1)
          throw new Error(`Character group '${index}' is unexpectedly empty.`);
        continue;
      }

      const pieces = await this.characterHairPieces(index);
      const armor = {
        chest: [],
        legs: [],
        gloves: [],
        boots: [],
      } as GD.ICharacterArmorOptions;

      for (const slot of Object.keys(CHARACTER_ARMOR_SLOTS) as (keyof typeof CHARACTER_ARMOR_SLOTS)[]) {
        const items = armorRows
          .filter(
            (item) =>
              item.body_part === CHARACTER_ARMOR_SLOTS[slot] &&
              getCharacterArmorPaths(row, item).length > 0,
          )
          .map((item) => ({
            id: item.id,
            label: getCharacterArmorLabel(item, itemNames),
            grade: item.crystal_type,
          }))
          .sort(
            (a, b) =>
              a.grade - b.grade ||
              a.label.localeCompare(b.label) ||
              a.id - b.id,
          );
        const labelCounts = new Map<string, number>();

        for (const item of items)
          labelCounts.set(item.label, (labelCounts.get(item.label) || 0) + 1);

        armor[slot] = items.map((item) => ({
          id: item.id,
          label:
            labelCounts.get(item.label) > 1
              ? `${item.label} (#${item.id})`
              : item.label,
        }));
      }

      groups.push({
        index,
        name: splitObjectPath(row.face_mesh[0] as string)[1].replace(
          /_m\d+_f$/,
          "",
        ),
        faceVariants: (row.face_tex as string[]).length,
        hairStyles: [...pieces.keys()].sort((a, b) => a - b),
        hairColours: Object.fromEntries(
          [...pieces].map(([style, colours]) => [
            style,
            [...colours.keys()].sort((a, b) => a - b),
          ]),
        ),
        armor,
      });
    }

    return groups;
  }

  /* decodes one assembly straight from chargrp.dat; armour variants always take this path,
     the bundle only ever holds the naked body */
  protected async decodeCharacterFromSource(
    settings: GD.LoadSettings_T,
    charIndex: number,
    meshPaths: string[],
    texturePaths: string[],
    includeAnimations: boolean,
  ): Promise<DecodeLibrary> {
    const rows = await this.decodeCharGrp();
    const row = getCharacterRow(rows, charIndex);
    const library = new DecodeLibrary();
    const builder = new DecodeLibraryBuilder(library, settings);

    library.name = splitObjectPath(row.face_mesh[0])[1];

    for (let i = 0, len = meshPaths.length; i < len; i++) {
      const mesh = await this.fetchSkeletalMesh(meshPaths[i]);
      const texture = await this.fetchCharacterMaterial(texturePaths[i]);
      const meshInfo = builder.pullSkeletalMesh(
        mesh,
        i === 0 && includeAnimations,
        false,
        i === 0,
      );
      const textureUuid = builder.pullMaterial(texture);
      const material = library.materials[meshInfo.materials] as GD.IMaterialGroupDecodeInfo;

      if (!material || material.materialType !== "group")
        throw new Error(
          `Skeletal mesh '${meshPaths[i]}' has no material group.`,
        );

      material.materials = [textureUuid];
      meshInfo.animations =
        i === 0 && includeAnimations ? meshInfo.animations : {};
      meshInfo.animationSequences =
        i === 0 && includeAnimations ? meshInfo.animationSequences : {};
      meshInfo.animationNotifies =
        i === 0 && includeAnimations ? meshInfo.animationNotifies : {};

      if (i === 0)
        meshInfo.skinMaterials = await this.pullCharacterSkinMaterials(
          builder,
          meshInfo.skinNotifies,
          texturePaths[i],
          textureUuid,
        );
      else meshInfo.skinNotifies = {};

      if (i === 0)
        meshInfo.animationSet = characterBundleCacheName(
          charIndex,
          library.name.replace(/_m\d+_f$/, ""),
        );

      library.pawnActors.push(meshInfo);
    }

    await this.applyCharacterHairConfig(library.pawnActors, meshPaths);

    prepareLibraryForTransfer(library, this.collectPackageBuffers());

    if ((settings as any).rgbaTextures !== false)
      convertDDSMaterialsToRGBA(library);

    return library;
  }

  /* the naked body of one character group, every face/hair/mesh/material variant of it:
     the expensive part of a character decode, reused by every later assembly */
  protected async buildCharacterBundle(
    settings: GD.LoadSettings_T,
    charIndex: number,
  ): Promise<DecodeLibrary> {
    const rows = await this.decodeCharGrp();
    const row = getCharacterRow(rows, charIndex);
    const name = splitObjectPath(row.face_mesh[0])[1].replace(/_m\d+_f$/, "");
    const cacheName = characterBundleCacheName(charIndex, name);
    const meshPaths = new Set<string>();
    const texturePaths = new Set<string>();
    const hairPieces = await this.characterHairPieces(charIndex);

    for (let face = 0, len = row.face_tex.length; face < len; face++) {
      for (const [hair, colours] of hairPieces) {
        for (const colour of colours.keys()) {
          const [meshes, textures] = resolveCharacterPartPaths(
            row,
            hairPieces,
            [],
            face,
            hair,
            colour,
            { chest: 0, legs: 0, gloves: 0, boots: 0 },
          );

          for (const path of meshes) meshPaths.add(path);
          for (const path of textures) texturePaths.add(path);
        }
      }
    }

    const library = new DecodeLibrary();
    const builder = new DecodeLibraryBuilder(library, {
      ...settings,
      rgbaTextures: false,
    } as GD.LoadSettings_T);
    const manifest: CharacterBundle_T = {
      name,
      animationSet: cacheName,
      animations: {},
      animationSequences: {},
      animationNotifies: {},
      skinNotifies: {},
      meshes: {},
      materials: {},
    };
    const faceMesh = row.face_mesh[0] as string;

    library.name = name;

    for (const path of meshPaths) {
      const mesh = await this.fetchSkeletalMesh(path);
      const info = builder.pullSkeletalMesh(mesh, path === faceMesh, false);

      if (path === faceMesh) {
        manifest.animations = info.animations;
        manifest.animationSequences = info.animationSequences;
        manifest.animationNotifies = info.animationNotifies;
        manifest.skinNotifies = info.skinNotifies;
      }

      info.animations = {};
      info.animationSequences = {};
      info.animationNotifies = {};
      info.skinNotifies = {};
      manifest.meshes[path] = info.uuid;
      library.pawnActors.push(info);
    }

    for (const path of row.face_tex as string[])
      for (const index of getSkinNotifyIndices(manifest.skinNotifies))
        texturePaths.add(getSkinMaterialPath(path, index));

    for (const path of texturePaths)
      manifest.materials[path] = builder.pullMaterial(
        await this.fetchCharacterMaterial(path),
      );

    (library as any).characterBundle = manifest;

    prepareLibraryForTransfer(library, this.collectPackageBuffers());

    return library;
  }

  /**
   * One full character: face + hair + body parts, plus armour when a slot is selected.
   * `charIndex` indexes chargrp.dat, `*Variant`/`hairColour` are indices into that group's
   * option lists (see decodeCharGroups), `armor` holds item ids per slot.
   */
  public async decodeCharacter(
    settings: GD.LoadSettings_T,
    charIndex: number = 1,
    faceVariant: number = 0,
    hairVariant: number = 0,
    hairColour: number = 0,
    armor: GD.ICharacterArmorSelection = { chest: 0, legs: 0, gloves: 0, boots: 0 },
    includeAnimations: boolean = true,
  ): Promise<DecodeLibrary> {
    await this.sweepCache(settings);

    const rows = await this.decodeCharGrp();
    const row = getCharacterRow(rows, charIndex);
    const [meshPaths, texturePaths] = await this.characterPartPaths(
      charIndex,
      faceVariant,
      hairVariant,
      hairColour,
      armor,
    );
    const cached = this.cacheCharacterBundles.get(charIndex);
    const cacheName = characterBundleCacheName(
      charIndex,
      splitObjectPath(row.face_mesh[0])[1].replace(/_m\d+_f$/, ""),
    );

    /* armour swaps parts the bundle does not carry, so it is always assembled from source */
    if (Object.values(armor).some((id) => id !== 0))
      return this.decodeCharacterFromSource(
        settings,
        charIndex,
        meshPaths,
        texturePaths,
        includeAnimations,
      );

    if (!cached)
      return this.decodeCharacterFromSource(
        settings,
        charIndex,
        meshPaths,
        texturePaths,
        includeAnimations,
      );

    const bundle = cached.library;
    const manifest = (bundle as any).characterBundle as CharacterBundle_T;
    const library = new DecodeLibrary();
    const actors = new Map(bundle.pawnActors.map((info) => [info.uuid, info]));

    library.name = manifest.name;

    copyAnimationSounds(library, bundle, manifest.animationNotifies);

    for (let i = 0, len = meshPaths.length; i < len; i++) {
      const actor = actors.get(manifest.meshes[meshPaths[i]]);
      const textureUuid = manifest.materials[texturePaths[i]];

      if (!actor)
        throw new Error(
          `Character mesh '${meshPaths[i]}' not found in '${cacheName}'.`,
        );
      if (!textureUuid)
        throw new Error(
          `Character material '${texturePaths[i]}' not found in '${cacheName}'.`,
        );

      const info = Object.assign({}, actor);
      const material = bundle.materials[info.materials] as GD.IMaterialGroupDecodeInfo;

      if (!material || material.materialType !== "group")
        throw new Error(
          `Character mesh '${meshPaths[i]}' has no material group in '${cacheName}'.`,
        );

      library.geometries[info.geometry] = bundle.geometries[info.geometry];
      library.materials[info.materials] = Object.assign({}, material, {
        materials: [textureUuid],
      });
      copyCharacterMaterial(library, bundle, textureUuid);

      info.animations = i === 0 && includeAnimations ? manifest.animations : {};
      info.animationSequences =
        i === 0 && includeAnimations ? manifest.animationSequences : {};
      info.animationNotifies =
        i === 0 && includeAnimations ? manifest.animationNotifies : {};

      if (i === 0) {
        info.animationSet = manifest.animationSet;
        info.skinNotifies = manifest.skinNotifies;
        info.skinMaterials = {};

        for (const index of getSkinNotifyIndices(manifest.skinNotifies)) {
          const path = getSkinMaterialPath(texturePaths[i], index);
          const uuid = manifest.materials[path];

          if (!uuid)
            throw new Error(
              `Character skin material '${path}' not found in '${cacheName}'.`,
            );

          info.skinMaterials[index] = uuid;
          copyCharacterMaterial(library, bundle, uuid);
        }
      } else info.skinNotifies = {};

      library.pawnActors.push(info);
    }

    await this.applyCharacterHairConfig(library.pawnActors, meshPaths);

    if ((settings as any).rgbaTextures !== false)
      convertDDSMaterialsToRGBA(library);

    return library;
  }

  public async decodeCharacterBinary(
    settings: GD.LoadSettings_T,
    charIndex: number,
    faceVariant: number,
    hairVariant: number,
    hairColour: number,
    armor: GD.ICharacterArmorSelection,
    includeAnimations: boolean,
  ): Promise<ArrayBuffer> {
    return serializeLibrary(
      await this.decodeCharacter(
        settings,
        charIndex,
        faceVariant,
        hairVariant,
        hairColour,
        armor,
        includeAnimations,
      ),
    ).buffer as ArrayBuffer;
  }

  /**
   * One skeletal mesh, straight out of its package. `texturePaths` replaces the mesh's own
   * material list when given; `includeAnimations: false` drops the clips (a body part other
   * than the face only ever plays the assembly's shared set).
   */
  public async decodeSkeletalMesh(
    settings: GD.LoadSettings_T,
    packageName: string,
    meshName: string,
    scriptClassPath: string = null,
    texturePaths: string[] = [],
    npcId: number = null,
    includeAnimations: boolean = true,
  ): Promise<DecodeLibrary> {
    /* both of these need machinery from a later phase, not a silent no-op */
    if (npcId !== null)
      throw new Error(
        `NPC '${npcId}' cannot be decoded yet - NPC resolution (npcgrp.dat) lands in Phase 5.`,
      );
    if (scriptClassPath)
      throw new Error(
        `Script-bound mesh '${packageName}.${meshName}' cannot be decoded yet - UnrealScript classes land in Phase 4.`,
      );

    await this.sweepCache(settings);

    const mesh = await this.fetchSkeletalMesh(`${packageName}.${meshName}`);
    const library = new DecodeLibrary();
    const builder = new DecodeLibraryBuilder(library, settings);
    const meshInfo = builder.pullSkeletalMesh(
      mesh,
      includeAnimations,
      texturePaths.length === 0,
    );

    library.name = mesh.objectName;
    library.pawnActors.push(meshInfo);

    if (texturePaths.length > 0) {
      const material = library.materials[meshInfo.materials] as GD.IMaterialGroupDecodeInfo;

      if (!material || material.materialType !== "group")
        throw new Error(
          `Skeletal mesh '${packageName}.${meshName}' has no material group.`,
        );

      material.materials = await Promise.all(
        texturePaths.map(async (path) =>
          builder.pullMaterial(await this.fetchCharacterMaterial(path)),
        ),
      );
    }

    prepareLibraryForTransfer(library, this.collectPackageBuffers());

    if ((settings as any).rgbaTextures !== false)
      convertDDSMaterialsToRGBA(library);

    return library;
  }

  public async decodeSkeletalMeshBinary(
    settings: GD.LoadSettings_T,
    packageName: string,
    meshName: string,
    scriptClassPath: string = null,
    texturePaths: string[] = [],
    npcId: number = null,
    includeAnimations: boolean = true,
  ): Promise<ArrayBuffer> {
    return serializeLibrary(
      await this.decodeSkeletalMesh(
        settings,
        packageName,
        meshName,
        scriptClassPath,
        texturePaths,
        npcId,
        includeAnimations,
      ),
    ).buffer as ArrayBuffer;
  }

  /**
   * Warms the in-memory character bundles of every playable group so a later character
   * swap only assembles parts. The bundles are not written to the OPFS decode cache: the
   * cache has no partial-hydration read path yet (see library-serializer).
   */
  public async precacheCharacters(settings: GD.LoadSettings_T): Promise<void> {
    await this.sweepCache(settings);

    const groups = await this.decodeCharGroups();

    if (settings.cache?.enabled === false) return;

    for (const group of groups) {
      if (this.cacheCharacterBundles.has(group.index)) continue;

      const bundle = await this.buildCharacterBundle(settings, group.index);

      this.cacheCharacterBundles.set(group.index, { library: bundle });
    }
  }

  public async initialize(): Promise<void> {
    const assetList = await (await fetch("/asset-list.json")).json();

    this.musicAssets = assetList.music ?? {};
    this.assetLoader = await AssetLoader.Instantiate(assetList.supported);

    /* same bootstrap AssetManager.initialize performs before any level decode */
    await this.assetLoader.using(this.assetLoader.getNativePackage(), {
      neverUnload: true,
    });
    const pkgCore = await this.assetLoader.using(
      this.assetLoader.getCorePackage(),
      { neverUnload: true },
    );
    await this.assetLoader.using(this.assetLoader.getEnginePackage(), {
      neverUnload: true,
    });

    pkgCore.loadNativeClasses();
  }

  /**
   * Every ArrayBuffer of a package decoded so far - used by the transfer walk to make
   * sure no library value ever transfers (= detaches) a package buffer.
   */
  protected collectPackageBuffers(): Set<ArrayBuffer> {
    const buffers = new Set<ArrayBuffer>();

    for (const packages of (this.assetLoader as any).packages.values()) {
      for (const pkg of packages.values()) {
        const buffer = (pkg as any).buffer;

        if (buffer instanceof ArrayBuffer) buffers.add(buffer);
      }
    }

    return buffers;
  }

  public async decodeSector(
    sectorName: string,
    settings: GD.LoadSettings_T,
  ): Promise<{ library: any; fromCache: boolean }> {
    if (!this.hasSweptCache) {
      await sweepDecodeCache(settings);
      this.hasSweptCache = true;
    }

    // console.log(`[decode] decoding sector '${sectorName}'`);

    const start = performance.now();
    const result = await this.decodeSectorCore(sectorName, settings);

    // console.log(`[decode] sector '${sectorName}' decoded in ${(performance.now() - start).toFixed(0)}ms${result.fromCache ? " (from cache)" : ""}`);

    return result;
  }

  public async decodeSectorBinary(
    sectorName: string,
    settings: GD.LoadSettings_T,
  ): Promise<BinarySector_T> {
    if (!this.hasSweptCache) {
      await sweepDecodeCache(settings);
      this.hasSweptCache = true;
    }

    // console.log(`[decode] decoding sector '${sectorName}'`);

    const start = performance.now();
    const result = await this.decodeSectorBinaryCore(sectorName, settings);

    // console.log(`[decode] sector '${sectorName}' decoded in ${(performance.now() - start).toFixed(0)}ms${result.fromCache ? " (from cache)" : ""}`);

    return result;
  }

  public async precacheSector(
    sectorName: string,
    settings: GD.LoadSettings_T,
  ): Promise<PrecacheResult_T> {
    if (!this.hasSweptCache) {
      await sweepDecodeCache(settings);
      this.hasSweptCache = true;
    }

    if (await hasCachedLibrary(sectorName, settings))
      return { cached: true, bytes: 0 };

    try {
      const pkg = await this.assetLoader.using(
        this.assetLoader.getPackage(sectorName, "Level"),
      );
      const library = buildDecodeLibrary(pkg, sectorName, settings);

      buildStaticMeshBatchData(library);
      prepareLibraryForTransfer(library, this.collectPackageBuffers());

      return {
        cached: false,
        bytes: await storeCachedLibraryDurable(sectorName, settings, library),
      };
    } finally {
      this.freeSector(sectorName);
    }
  }

  protected async decodeSectorCore(
    sectorName: string,
    settings: GD.LoadSettings_T,
  ): Promise<{ library: any; fromCache: boolean }> {
    const convertToRGBA = (settings as any).rgbaTextures !== false; // false = client uploads DDS as-is (s3tc)

    // never cache the skylevel, sky renderer matches its sections against env config
    // material uuids which are session-random - a cached skylevel never matches
    const cacheable = !(settings as any).isSkyLevel;

    const cached = cacheable
      ? await loadCachedLibrary(sectorName, settings)
      : null;

    if (cached) {
      if (convertToRGBA)
        convertDDSMaterialsToRGBA(
          cached,
        ); /* the cache stores DDS (4-8x smaller than RGBA) */
      refreshSoundBlobUris(cached); /* blob URLs are session-scoped */

      return { library: cached, fromCache: true };
    }

    const pkg = await this.assetLoader.using(
      this.assetLoader.getPackage(sectorName, "Level"),
    );
    const library = buildDecodeLibrary(pkg, sectorName, settings);

    buildStaticMeshBatchData(library);

    /*
     * Sanitize before caching so the cache only ever sees plain data; this pass's
     * transfer list is discarded (the DXT conversion below swaps texture buffers).
     * storeCachedLibrary serializes now and writes in the background.
     */
    prepareLibraryForTransfer(library, this.collectPackageBuffers());

    if (cacheable) storeCachedLibrary(sectorName, settings, library);

    if (convertToRGBA) convertDDSMaterialsToRGBA(library);

    return { library, fromCache: false };
  }

  protected async decodeSectorBinaryCore(
    sectorName: string,
    settings: GD.LoadSettings_T,
  ): Promise<BinarySector_T> {
    const convertToRGBA = (settings as any).rgbaTextures !== false;
    const cacheable = !(settings as any).isSkyLevel;
    const cachedBuffer = cacheable
      ? await loadCachedLibraryBuffer(sectorName, settings)
      : null;

    if (cachedBuffer) {
      if (!convertToRGBA) return { buffer: cachedBuffer, fromCache: true };

      const library = deserializeLibrary(cachedBuffer);

      convertDDSMaterialsToRGBA(library);

      return {
        buffer: serializeLibrary(library).buffer as ArrayBuffer,
        fromCache: true,
      };
    }

    const pkg = await this.assetLoader.using(
      this.assetLoader.getPackage(sectorName, "Level"),
    );
    const library = buildDecodeLibrary(pkg, sectorName, settings);

    buildStaticMeshBatchData(library);
    prepareLibraryForTransfer(library, this.collectPackageBuffers());

    let buffer: ArrayBuffer = null;

    if (cacheable) {
      buffer = serializeLibrary(library).buffer as ArrayBuffer;
      await storeCachedLibraryBufferDurable(sectorName, settings, buffer);
    }

    if (convertToRGBA) {
      buffer = null;
      convertDDSMaterialsToRGBA(library);
    }

    if (!buffer) buffer = serializeLibrary(library).buffer as ArrayBuffer;

    return { buffer, fromCache: false };
  }

  public freeSector(sectorName: string) {
    try {
      this.assetLoader.free(this.assetLoader.getPackage(sectorName, "Level"));
    } catch (e) {} // sector was decoded from cache - its packages were never loaded here
  }

  public async decodeEnvConfig(): Promise<any> {
    const pkgL2Skies = await this.assetLoader.using(
      this.assetLoader.getPackage("l2_skies", "Texture"),
      { neverUnload: true },
    );
    const envFile = await new UConfigEnv("/assets/system/env.int")
      .asReadable()
      .decode();
    const envConfig = await envFile.load(
      this.assetLoader.getNativePackage(),
      this.assetLoader.getEnginePackage(),
      pkgL2Skies,
    );

    return envConfig.getDecodeInfo();
  }

  /* musicinfo.dat lists loose .ogg track names per music id; resolve each to the server URL
       generated into asset-list.json. Music files are not UE2 packages - the asset loader has
       no "Music" import type, AudioManager fetches these URLs directly. */
  protected resolveMusicPath(sound: string): string {
    const base = sound.split(/[\\/]/).pop()!.toLowerCase();
    const key = base.endsWith(".ogg") ? base : `${base}.ogg`;

    return this.musicAssets[key] ?? `assets/music/${key}`;
  }

  public async decodeMusicInfo(): Promise<Record<number, string[]>> {
    try {
      const file = await new UDataFile(
        SCHEMA_MUSICINFO_DAT,
        "/assets/system/musicinfo.dat",
      )
        .asReadable()
        .decode();

      return Object.fromEntries(
        file.datarows.map((row: any) => [
          row.id,
          (row.sounds as string[]).map((sound) => this.resolveMusicPath(sound)),
        ]),
      );
    } catch (e) {
      console.warn(
        "[decode-engine] failed to decode music info, continuing without music:",
        e,
      );
      return {};
    }
  }

  /* postMessage transfer list for a value already produced by this engine - the sanitize
       pass inside decodeSectorCore already ran, this only needs to (re)walk for buffers */
  public collectTransferables(value: any): ArrayBuffer[] {
    return prepareLibraryForTransfer(value, this.collectPackageBuffers());
  }
}

export default DecodeEngine;
export { DecodeEngine };
