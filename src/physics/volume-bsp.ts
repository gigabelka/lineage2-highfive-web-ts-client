import type { Vector3 } from "three";

/**
 * Structural shape of any UE2 volume brush BSP the client can trace against.
 *
 * Deliberately kept standalone (not tied to `GD.IMusicVolumeDecodeInfo["bsp"]`) - Phase 7's
 * water/physics volumes reuse these two functions with the same node layout.
 */
type IMusicVolumeBspNode = GD.IMusicVolumeBspNode;
export type IVolumeBspDecodeInfo = {
    isRootOutside: boolean;
    nodes: IMusicVolumeBspNode[];
};

let traceStart: Vector3 = null;
let traceEnd: Vector3 = null;
let traceStartsInside = false;
let traceTime = 1;

function childOutside(node: IMusicVolumeBspNode, front: boolean, outside: boolean): boolean {
    return front ? outside || node.isCsg : outside && !node.isCsg;
}

export function encompassesVolume(position: Vector3, bsp: IVolumeBspDecodeInfo): boolean {
    let outside = bsp.isRootOutside;
    const nodes = bsp.nodes;

    if (nodes.length > 0) {
        let iNode = 0;

        do {
            const node = nodes[iNode];
            const plane = node.plane;
            const isFront = plane[0] * position.x + plane[1] * position.y + plane[2] * position.z - plane[3] > 0;

            outside = childOutside(node, isFront, outside);
            iNode = isFront ? node.iFront : node.iBack;
        } while (iNode !== -1);
    }

    return !outside;
}

function planeDistance(node: IMusicVolumeBspNode, time: number): number {
    const plane = node.plane;
    const x = traceStart.x + (traceEnd.x - traceStart.x) * time;
    const y = traceStart.y + (traceEnd.y - traceStart.y) * time;
    const z = traceStart.z + (traceEnd.z - traceStart.z) * time;

    return plane[0] * x + plane[1] * y + plane[2] * z - plane[3];
}

function traceNode(nodes: IMusicVolumeBspNode[], iNode: number, startTime: number, endTime: number, outside: boolean): boolean {
    if (iNode === -1) {
        if ((!outside) !== traceStartsInside) {
            traceTime = startTime;
            return true;
        }

        return false;
    }

    const node = nodes[iNode];
    const distStart = planeDistance(node, startTime);
    const distEnd = planeDistance(node, endTime);

    if (distStart > -0.001 && distEnd > -0.001)
        return traceNode(nodes, node.iFront, startTime, endTime, childOutside(node, true, outside));
    if (distStart < 0.001 && distEnd < 0.001)
        return traceNode(nodes, node.iBack, startTime, endTime, childOutside(node, false, outside));

    const middleTime = startTime + (endTime - startTime) * distStart / (distStart - distEnd);
    const frontFirst = distStart > 0;
    const firstNode = frontFirst ? node.iFront : node.iBack;
    const secondNode = frontFirst ? node.iBack : node.iFront;

    if (traceNode(nodes, firstNode, startTime, middleTime, childOutside(node, frontFirst, outside))) return true;

    return traceNode(nodes, secondNode, middleTime, endTime, childOutside(node, !frontFirst, outside));
}

export function findVolumeTransition(start: Vector3, end: Vector3, bsp: IVolumeBspDecodeInfo, startsInside: boolean = encompassesVolume(start, bsp)): number {
    if (bsp.nodes.length === 0) return 1;

    traceStart = start;
    traceEnd = end;
    traceStartsInside = startsInside;
    traceTime = 1;
    traceNode(bsp.nodes, 0, 0, 1, bsp.isRootOutside);

    return traceTime;
}
