"""
Mesh data service for RenderDoc: decoded vertices of a draw, before and after the vertex stages.

Follows RenderDoc's decode_mesh.py sample. Buffer contents depend on the replayed event, so every
read moves replay to the draw first.
"""

import json
import os
import struct
import traceback

import renderdoc as rd

# Vertices returned inline before the result is cut (it goes through the model context).
# Larger reads should pass output_path.
DEFAULT_MAX_VERTICES = 64

# rd.MeshDataStage for each stage name; vs_in reads the vertex buffers themselves
OUTPUT_STAGES = {
    "vs_out": (rd.MeshDataStage.VSOut, rd.ShaderStage.Vertex),
    "gs_out": (rd.MeshDataStage.GSOut, rd.ShaderStage.Geometry),
}
STAGE_NAMES = ("vs_in",) + tuple(sorted(OUTPUT_STAGES))

# struct characters, indexed by component byte width
UINT_CHARS = "xBHxIxxxQ"
SINT_CHARS = "xbhxixxxq"
FLOAT_CHARS = "xxexfxxxd"


def _is_unorm(comp_type):
    return comp_type in (rd.CompType.UNorm, rd.CompType.UNormSRGB)


def _comp_chars(comp_type):
    if comp_type == rd.CompType.Float:
        return FLOAT_CHARS
    if comp_type in (rd.CompType.SInt, rd.CompType.SNorm, rd.CompType.SScaled):
        return SINT_CHARS
    return UINT_CHARS


def decode_element(fmt, data, offset):
    """Decode one attribute value. Returns a list, or None when it lies past the end of data."""
    if fmt.Special():
        raise ValueError("Packed format %s is not supported" % fmt.Name())

    layout = "<%d%s" % (fmt.compCount, _comp_chars(fmt.compType)[fmt.compByteWidth])
    if offset + struct.calcsize(layout) > len(data):
        return None
    value = list(struct.unpack_from(layout, data, offset))

    if _is_unorm(fmt.compType):
        divisor = float(2 ** (fmt.compByteWidth * 8) - 1)
        value = [v / divisor for v in value]
    elif fmt.compType == rd.CompType.SNorm:
        lowest = -(2 ** (fmt.compByteWidth * 8 - 1))
        divisor = float(-lowest - 1)
        value = [-1.0 if v == lowest else v / divisor for v in value]

    if fmt.BGRAOrder():
        value = [value[i] for i in (2, 1, 0, 3)]
    return value


class _Attribute(object):
    """One decoded stream: where its bytes live and how to read them"""

    def __init__(self, name, fmt, resource, offset, stride, fixed_index=None):
        self.name = name
        self.fmt = fmt
        self.resource = resource
        self.offset = offset
        self.stride = stride
        # Per-instance attributes read this element instead of the vertex index
        self.fixed_index = fixed_index


class MeshService:
    """Decoded vertex data of a draw"""

    def __init__(self, ctx, invoke_fn):
        self.ctx = ctx
        self._invoke = invoke_fn

    def get_mesh_data(
        self,
        event_id,
        stage="vs_in",
        first=0,
        count=0,
        instance=0,
        output_path=None,
        max_vertices=DEFAULT_MAX_VERTICES,
    ):
        """
        Decode the vertices of a draw.

        stage: vs_in (vertex buffers), vs_out or gs_out (post-transform data).
        first / count select a range of the draw's vertices, in draw order (count 0 = to the end).
        output_path writes every selected vertex to a JSON file and returns only the summary.
        """
        if not self.ctx.IsCaptureLoaded():
            raise ValueError("No capture loaded")
        if stage not in STAGE_NAMES:
            raise ValueError("Unknown stage %s (expected one of %s)" % (stage, ", ".join(STAGE_NAMES)))
        if output_path is not None and not os.path.isabs(output_path):
            raise ValueError("output_path must be an absolute path: %s" % output_path)

        result = {"data": None, "error": None}

        def callback(controller):
            try:
                controller.SetFrameEvent(event_id, True)

                action = self.ctx.GetAction(event_id)
                if not action or not (action.flags & rd.ActionFlags.Drawcall):
                    result["error"] = "No draw call at event %d" % event_id
                    return

                pipe = controller.GetPipelineState()
                if stage == "vs_in":
                    mesh = self._mesh_inputs(pipe, action, instance)
                else:
                    mesh = self._mesh_outputs(controller, pipe, stage, instance)
                    if mesh is None:
                        result["error"] = "No %s data at event %d" % (stage, event_id)
                        return

                result["data"] = self._read(
                    controller, mesh, event_id, stage, first, count, output_path, max_vertices
                )
            except Exception as e:
                result["error"] = "%s\n%s" % (e, traceback.format_exc())

        self._invoke(callback)

        if result["error"]:
            raise ValueError(result["error"])
        return result["data"]

    @staticmethod
    def _mesh_inputs(pipe, action, instance):
        """Describe the vertex buffer streams of the current draw"""
        vbs = pipe.GetVBuffers()
        ib = pipe.GetIBuffer()
        indexed = bool(action.flags & rd.ActionFlags.Indexed)

        attributes = []
        for attr in pipe.GetVertexInputs():
            if not attr.used or attr.genericEnabled:
                continue
            vb = vbs[attr.vertexBuffer]
            fixed_index = None
            offset = attr.byteOffset + vb.byteOffset
            if attr.perInstance:
                rate = max(1, attr.instanceRate)
                fixed_index = action.instanceOffset + instance // rate
            else:
                offset += action.vertexOffset * vb.byteStride
            attributes.append(
                _Attribute(attr.name, attr.format, vb.resourceId, offset, vb.byteStride, fixed_index)
            )

        return {
            "attributes": attributes,
            "topology": str(pipe.GetPrimitiveTopology()),
            "num_indices": action.numIndices,
            "index_resource": ib.resourceId if indexed else rd.ResourceId.Null(),
            "index_byte_offset": ib.byteOffset,
            "index_stride": ib.byteStride,
            "index_first": action.indexOffset,
            "base_vertex": action.baseVertex,
        }

    @staticmethod
    def _mesh_outputs(controller, pipe, stage, instance):
        """Describe the post-transform streams of the current draw (position comes first)"""
        data_stage, shader_stage = OUTPUT_STAGES[stage]
        reflection = pipe.GetShaderReflection(shader_stage)
        if not reflection:
            return None
        postvs = controller.GetPostVSData(instance, 0, data_stage)
        if postvs.vertexResourceId == rd.ResourceId.Null():
            return None

        outputs = []
        for sig in reflection.outputSignature:
            fmt = rd.ResourceFormat()
            fmt.compByteWidth = rd.VarTypeByteSize(sig.varType)
            fmt.compCount = sig.compCount
            fmt.compType = rd.VarTypeCompType(sig.varType)
            fmt.type = rd.ResourceFormatType.Regular
            name = sig.varName if sig.varName else sig.semanticIdxName
            if sig.systemValue == rd.ShaderBuiltin.Position:
                outputs.insert(0, (name, fmt))
            else:
                outputs.append((name, fmt))

        attributes = []
        offset = postvs.vertexByteOffset
        for name, fmt in outputs:
            attributes.append(
                _Attribute(name, fmt, postvs.vertexResourceId, offset, postvs.vertexByteStride)
            )
            offset += (8 if fmt.compByteWidth > 4 else 4) * fmt.compCount

        return {
            "attributes": attributes,
            "topology": str(postvs.topology),
            "num_indices": postvs.numIndices,
            "index_resource": postvs.indexResourceId,
            "index_byte_offset": postvs.indexByteOffset,
            "index_stride": postvs.indexByteStride,
            "index_first": 0,
            "base_vertex": postvs.baseVertex,
        }

    @staticmethod
    def _indices(controller, mesh):
        """Vertex index of every element of the draw, in draw order"""
        if mesh["index_resource"] == rd.ResourceId.Null():
            return list(range(mesh["num_indices"]))

        stride = mesh["index_stride"]
        char = {1: "B", 2: "H", 4: "I"}[stride]
        data = controller.GetBufferData(mesh["index_resource"], mesh["index_byte_offset"], 0)
        start = mesh["index_first"] * stride
        available = max(0, (len(data) - start) // stride)
        count = min(mesh["num_indices"], available)
        values = struct.unpack_from("<%d%s" % (count, char), data, start)
        return [v + mesh["base_vertex"] for v in values]

    def _read(self, controller, mesh, event_id, stage, first, count, output_path, max_vertices):
        """Decode the selected vertices into one column per attribute"""
        indices = self._indices(controller, mesh)
        total = len(indices)
        selected = indices[first : first + count] if count > 0 else indices[first:]

        truncated = False
        if output_path is None and max_vertices and len(selected) > max_vertices:
            selected = selected[:max_vertices]
            truncated = True

        buffers = {}
        columns = {}
        attributes = []
        for attr in mesh["attributes"]:
            key = str(attr.resource)
            if key not in buffers:
                buffers[key] = controller.GetBufferData(attr.resource, 0, 0)
            data = buffers[key]

            name = attr.name
            suffix = 1
            while name in columns:
                suffix += 1
                name = "%s#%d" % (attr.name, suffix)

            column = []
            for index in selected:
                element = index if attr.fixed_index is None else attr.fixed_index
                column.append(decode_element(attr.fmt, data, attr.offset + element * attr.stride))
            columns[name] = column
            attributes.append(
                {
                    "name": name,
                    "format": str(attr.fmt.Name()),
                    "byte_offset": attr.offset,
                    "byte_stride": attr.stride,
                    "resource_id": key,
                }
            )

        summary = {
            "event_id": event_id,
            "stage": stage,
            "topology": mesh["topology"],
            "vertex_count": total,
            "first": first,
            "returned": len(selected),
            "truncated": truncated,
            "attributes": attributes,
        }

        if output_path is None:
            summary["indices"] = selected
            summary["columns"] = columns
            return summary

        directory = os.path.dirname(output_path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        payload = dict(summary)
        payload["indices"] = selected
        payload["columns"] = columns
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        summary["path"] = output_path
        return summary
