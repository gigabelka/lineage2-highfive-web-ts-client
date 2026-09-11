import { AAssetLoader, APackage } from "@l2js/core";

class AssetLoader extends AAssetLoader<
  C.APackage,
  GA.UCorePackage,
  GA.UEnginePackage,
  C.ANativePackage
> {
  protected pkgRefCounts = new Map<string, number>();

  static async Instantiate(assetList: C.IAssetListInfo) {
    const Library = await import(
      /* webpackChunkName: "modules/unreal" */ "@unreal/un-package"
    );

    return new AssetLoader().init(assetList, Library);
  }

  protected createNativePackage(
    UNativePackage: C.ANativePackageConstructor<C.ANativePackage>,
  ): C.ANativePackage {
    return new UNativePackage(this);
  }

  protected createPackage(
    UPackage:
      | C.APackageConstructor<C.APackage>
      | C.ACorePackageConstructor<GA.UCorePackage>
      | C.AEnginePackageConstructor<GA.UEnginePackage>,
    downloadPath: string,
  ): C.APackage {
    return new UPackage(this, `/assets/${downloadPath}`);
  }

  /**
   * Transitive closure of the packages `pkg` depends on, including `pkg` itself, as
   * `pkg.path` strings (the key `pkgRefCounts` uses). Mirrors the import walk in
   * `AAssetLoader.load()` but only collects - `using()` has already `await this.load(pkg)`
   * by the time this runs, so every package here is decoded and the walk is synchronous.
   */
  private static readonly PROBE_IMP_TYPES = [
    "Texture",
    "StaticMesh",
    "SkeletalMesh",
    "Sound",
    "Level",
    "Animation",
    "Effect",
    "Script",
  ];

  /**
   * Core's `getPackage(name, type)` throws on an import `className` that isn't in its
   * `impToTypes` map (many C4 material/texture subclasses aren't) and on a package name
   * that was never registered. This probes every extension bucket instead, so a stray or
   * unmapped className still resolves and a genuinely-absent package returns null.
   */
  protected resolvePackage(
    pkgName: string,
    impType?: string,
  ): C.APackage | null {
    const tries = impType
      ? [impType, ...AssetLoader.PROBE_IMP_TYPES]
      : AssetLoader.PROBE_IMP_TYPES;

    /*
     * Some original C4 texture/mesh packages (e.g. Oren_DEV_T.utx) carry a self-package
     * import whose name has a trailing underscore baked in at cook time ("Oren_DEV_T_"),
     * with no matching file. Fall back to the trimmed name so the self-reference resolves
     * to the package itself instead of throwing "does not exist".
     */
    const names =
      /_+$/.test(pkgName) && pkgName.replace(/_+$/, "").length > 0
        ? [pkgName, pkgName.replace(/_+$/, "")]
        : [pkgName];

    for (const name of names) {
      for (const t of tries) {
        try {
          const p = super.getPackage(name as any, t) as unknown as C.APackage;
          if (p) return p;
        } catch {
          /* unknown impType or unregistered package name - keep probing */
        }
      }
    }

    return null;
  }

  public getPackage(pkgName: any, impType?: any): any {
    if (arguments.length === 1) return super.getPackage(pkgName);

    const p = this.resolvePackage(pkgName, impType);

    if (!p) throw new Error(`Package '${pkgName}[${impType}]' not found!`);

    return p;
  }

  public hasPackage(pkgName: string, impType: string): boolean {
    return this.resolvePackage(pkgName, impType) !== null;
  }

  protected getDependencies(pkg: C.APackage): Set<string> {
    const seen = new Set<C.APackage>([pkg]);
    const stack: C.APackage[] = [pkg];

    while (stack.length > 0) {
      const cur = stack.pop();

      for (const entry of (cur.imports ?? []).filter(
        (imp: C.UImport) => imp.className !== "Package",
      )) {
        let ep = cur.getImportEntry(entry.idPackage);

        while (ep.idPackage !== 0) ep = cur.getImportEntry(ep.idPackage);

        const dep = this.getPackage(
          ep.objectName,
          entry.className,
        ) as C.APackage;

        if (dep && !seen.has(dep)) {
          seen.add(dep);
          stack.push(dep);
        }
      }
    }

    return new Set([...seen].map((p) => p.path));
  }

  public async using<T extends APackage = APackage>(
    pkg: T,
    props?: { neverUnload?: boolean },
  ): Promise<T> {
    const _pkg = await this.load(pkg);
    const w = (props?.neverUnload ?? false) ? Infinity : 1;

    for (const dep of this.getDependencies(pkg)) {
      if (!this.pkgRefCounts.has(dep)) this.pkgRefCounts.set(dep, 0);

      this.pkgRefCounts.set(dep, this.pkgRefCounts.get(dep) + w);
    }

    return _pkg;
  }

  public free<T extends APackage = APackage>(pkg: T) {
    const deref = new Array<string>();

    for (const dep of this.getDependencies(pkg)) {
      if (!this.pkgRefCounts.has(dep)) continue;

      const c = this.pkgRefCounts.get(dep);
      const nc = Math.max(0, this.pkgRefCounts.get(dep) - 1);

      if (c > 0 && nc === 0 && !deref.includes(dep)) deref.push(dep);

      this.pkgRefCounts.set(dep, nc);
    }

    for (const path of deref) (this.getPackage(path) as GA.UPackage).free();
  }
}

export default AssetLoader;
