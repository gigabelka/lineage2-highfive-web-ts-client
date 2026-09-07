import { UObject } from "@l2js/core";
import { UNativeRegistry } from "@l2js/core/src/unreal/un-native-registry";
import { generateUUID } from "three/src/math/MathUtils";

// C4 script bytecode references native function index 197 (an int `>>>`-family operator).
// core's disassembler (readToken) only needs a name, never executes it. Register it into
// core's native registry from here so it survives `npm install` (unlike patching core).
if (!UNativeRegistry.hasNativeFunc(197))
  UNativeRegistry.registerNativeFunc(197, function op_native_197() {
    throw new Error("native 197 is disasm-only");
  });

Object.assign(UObject, {
  ALLOW_EDITING: false,
  onClassCreated(this: typeof UObject, cls: new (...args: any) => UObject) {
    if (this === UObject) {
      console.warn(
        `Cannot register '${cls.name}' because it's directly inheriting 'UObject'.`,
      );
      return;
    }

    // console.log(this.name, "->", cls.name);

    const baseClass = this as any;

    baseClass["make"] = function (...args: any) {
      return new cls(...args);
    };
    baseClass["class"] = function () {
      return cls;
    };
  },
});

Object.defineProperty(UObject.prototype, "uuid", {
  get() {
    if (this._uuid !== undefined) return this._uuid;

    this._uuid = `${this.constructor.friendlyName ?? this.constructor.name}_${this.objectName}_${generateUUID()}`;

    // this._uuid = this.name ?? `${this.constructor.name}_${this.objectName}_${generateUUID()}`;

    return this._uuid;
  },
  configurable: true,
  enumerable: true,
});

Object.assign(UObject.prototype, {
  _uuid: undefined,
  // Tolerant replacement for core's UObject.loadProperty: C4 assets carry property tags
  // this port doesn't model (added in a different engine build, e.g. 'bNeedPostSpawnProcess',
  // 'AffectBoxMin'). Skip the tag's payload instead of aborting the whole sector decode.
  loadProperty(this: any, pkg: any, tag: any) {
    const offEnd = pkg.tell() + tag.dataSize;
    const varName = this.getPropertyVarName(tag);

    if (!varName) {
      pkg.seek(offEnd, "set");
      return;
    }

    let property: any;
    try {
      property = this.findValidProperty(varName);
    } catch {
      pkg.seek(offEnd, "set");
      return;
    }

    if (!property || property.type !== tag.type) {
      pkg.seek(offEnd, "set");
      return;
    }

    property.readProperty(pkg, tag, this.propertyDict);
    pkg.seek(offEnd, "set");
  },
  getDecodeInfo() {
    throw new Error(
      `'${this.constructor.name}' must implemented 'getDecodeInfo' method!`,
    );
  },
  onSuperConstructed() {},
  dumpLayout() {
    const layout = (this.constructor as any).inheritedProps as Record<
      string,
      string[]
    >;
    const layoutStrings = [`Layout of '${(this as any).objectName}':`];
    const pdict = (this as any).propertyDict as Record<string, any>;

    for (const [base, properties] of Object.entries(layout).reverse()) {
      layoutStrings.push("--------------------------------------");
      layoutStrings.push(`    '${base}' properties:`);

      if (properties.length > 0) {
        for (const propName of properties) {
          const paddingRequired = Math.max(25 - propName.length, 0);
          const padding = new Array(paddingRequired).fill(" ").join("");
          layoutStrings.push(
            `        '${propName}'${padding}:= ${pdict.get(propName)}`,
          );
        }
      } else layoutStrings.push(`        * no properties *`);
    }

    const layoutString = layoutStrings.join("\n");

    return layoutString;
  },
});
