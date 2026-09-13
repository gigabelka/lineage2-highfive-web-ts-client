async function main() {
  const FVector: any = (await import("@unreal/un-vector")).default;
  try { const v = new FVector(1, 2, 3); console.log("new FVector OK:", JSON.stringify(v)); }
  catch (e) { console.log("new FVector THREW:", (e as Error).message); }
  try { const v = FVector.make(1, 2, 3); console.log("FVector.make OK:", JSON.stringify(v), "isConstructed=", (v as any).isConstructed); }
  catch (e) { console.log("FVector.make THREW:", (e as Error).message); }
  const UObject: any = (await import("@l2js/core")).UObject;
  console.log("UObject.makeLayout === base thrower:", UObject.prototype.makeLayout.toString().includes("must be overloaded"));
  console.log("FVector.prototype.makeLayout own:", Object.prototype.hasOwnProperty.call(FVector.prototype, "makeLayout"));
  console.log("FVector proto chain names:", (() => { const out = []; let p = FVector.prototype; while (p) { out.push(p.constructor?.name); p = Object.getPrototypeOf(p); if (out.length > 6) break; } return out.join(" -> "); })());
}
main().catch(e => { console.error("FAIL", e); process.exit(1); });
