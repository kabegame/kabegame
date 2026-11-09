"""
Pipeline state service for RenderDoc.
"""

import re

import renderdoc as rd

from ..utils import Parsers, Serializers, Helpers


class PipelineService:
    """Pipeline state service"""

    def __init__(self, ctx, invoke_fn):
        self.ctx = ctx
        self._invoke = invoke_fn

    def get_shader_info(self, event_id, stage):
        """Get shader information for a specific stage"""
        if not self.ctx.IsCaptureLoaded():
            raise ValueError("No capture loaded")

        result = {"shader": None, "error": None}

        def callback(controller):
            controller.SetFrameEvent(event_id, True)

            pipe = controller.GetPipelineState()
            stage_enum = Parsers.parse_stage(stage)

            shader = pipe.GetShader(stage_enum)
            if shader == rd.ResourceId.Null():
                result["error"] = "No %s shader bound" % stage
                return

            entry = pipe.GetShaderEntryPoint(stage_enum)
            reflection = pipe.GetShaderReflection(stage_enum)

            shader_info = {
                "resource_id": str(shader),
                "entry_point": entry,
                "stage": stage,
            }

            # Get disassembly
            try:
                targets = controller.GetDisassemblyTargets(True)
                if targets:
                    disasm = controller.DisassembleShader(
                        pipe.GetGraphicsPipelineObject(), reflection, targets[0]
                    )
                    shader_info["disassembly"] = disasm
            except Exception as e:
                shader_info["disassembly_error"] = str(e)

            # Get constant buffer info
            if reflection:
                shader_info["constant_buffers"] = self._get_cbuffer_info(
                    controller, pipe, reflection, stage_enum
                )
                self._mark_referenced(shader_info)
                shader_info["resources"] = self._get_resource_bindings(reflection)

            result["shader"] = shader_info

        self._invoke(callback)

        if result["error"]:
            raise ValueError(result["error"])
        return result["shader"]

    def get_pipeline_state(self, event_id):
        """Get full pipeline state at an event"""
        if not self.ctx.IsCaptureLoaded():
            raise ValueError("No capture loaded")

        result = {"pipeline": None, "error": None}

        def callback(controller):
            controller.SetFrameEvent(event_id, True)

            pipe = controller.GetPipelineState()
            api = controller.GetAPIProperties().pipelineType

            pipeline_info = {
                "event_id": event_id,
                "api": str(api),
            }

            # Shader stages with detailed bindings
            stages = {}
            stage_list = Helpers.get_all_shader_stages()
            for stage in stage_list:
                shader = pipe.GetShader(stage)
                if shader != rd.ResourceId.Null():
                    stage_info = {
                        "resource_id": str(shader),
                        "entry_point": pipe.GetShaderEntryPoint(stage),
                    }

                    reflection = pipe.GetShaderReflection(stage)

                    stage_info["resources"] = self._get_stage_resources(
                        controller, pipe, stage, reflection
                    )
                    stage_info["uavs"] = self._get_stage_uavs(
                        controller, pipe, stage, reflection
                    )
                    stage_info["samplers"] = self._get_stage_samplers(
                        pipe, stage, reflection
                    )
                    stage_info["constant_buffers"] = self._get_stage_cbuffers(
                        controller, pipe, stage, reflection
                    )

                    stages[str(stage)] = stage_info

            pipeline_info["shaders"] = stages

            # Viewport and scissor
            # RenderDoc 1.32+ replaced GetViewportScissor/GetOutputMerger/GetIAState with
            # GetViewport/GetOutputTargets/GetColorBlends/GetPrimitiveTopology; keep both.
            try:
                if hasattr(pipe, "GetViewport"):
                    vp_list = [pipe.GetViewport(0)]
                else:
                    vp_list = list(pipe.GetViewportScissor().viewports)
                viewports = []
                for v in vp_list:
                    viewports.append(
                        {
                            "x": v.x,
                            "y": v.y,
                            "width": v.width,
                            "height": v.height,
                            "min_depth": v.minDepth,
                            "max_depth": v.maxDepth,
                        }
                    )
                pipeline_info["viewports"] = viewports
            except Exception as e:
                pipeline_info["viewports_error"] = str(e)

            # Render targets, depth target and per-target blending
            try:
                if hasattr(pipe, "GetOutputTargets"):
                    rts = []
                    for i, desc in enumerate(pipe.GetOutputTargets()):
                        if desc.resource != rd.ResourceId.Null():
                            rts.append({"index": i, "resource_id": str(desc.resource)})
                    pipeline_info["render_targets"] = rts

                    depth = pipe.GetDepthTarget()
                    if depth.resource != rd.ResourceId.Null():
                        pipeline_info["depth_target"] = str(depth.resource)

                    blends = list(pipe.GetColorBlends())
                    pipeline_info["color_blends"] = [
                        self._serialize_color_blend(rt["index"], blends[rt["index"]])
                        for rt in rts
                        if rt["index"] < len(blends)
                    ]
                else:
                    om = pipe.GetOutputMerger()
                    rts = []
                    for i, rt in enumerate(om.renderTargets):
                        if rt.resourceId != rd.ResourceId.Null():
                            rts.append({"index": i, "resource_id": str(rt.resourceId)})
                    pipeline_info["render_targets"] = rts

                    if om.depthTarget.resourceId != rd.ResourceId.Null():
                        pipeline_info["depth_target"] = str(om.depthTarget.resourceId)
            except Exception as e:
                pipeline_info["render_targets_error"] = str(e)

            # Input assembly
            try:
                pipeline_info["input_assembly"] = self._get_input_assembly(pipe)
            except Exception as e:
                pipeline_info["input_assembly_error"] = str(e)

            # Fixed-function state the abstract pipe does not expose
            if api == rd.GraphicsAPI.D3D11:
                try:
                    pipeline_info.update(self._get_d3d11_state(controller))
                except Exception as e:
                    pipeline_info["fixed_function_error"] = str(e)

            result["pipeline"] = pipeline_info

        self._invoke(callback)

        if result["error"]:
            raise ValueError(result["error"])
        return result["pipeline"]

    @staticmethod
    def _bound_size(size):
        """Bound byte size; D3D11 binds to the end of the buffer and reports UINT64_MAX"""
        return None if size == 2 ** 64 - 1 else size

    @classmethod
    def _get_input_assembly(cls, pipe):
        """Topology, vertex layout and bound vertex / index buffers"""
        info = {"topology": str(pipe.GetPrimitiveTopology())}

        info["vertex_inputs"] = [
            {
                "name": attr.name,
                "vertex_buffer": attr.vertexBuffer,
                "byte_offset": attr.byteOffset,
                "per_instance": attr.perInstance,
                "instance_rate": attr.instanceRate,
                "format": str(attr.format.Name()),
                "used": attr.used,
            }
            for attr in pipe.GetVertexInputs()
        ]

        buffers = []
        for slot, vb in enumerate(pipe.GetVBuffers()):
            if vb.resourceId != rd.ResourceId.Null():
                buffers.append(
                    {
                        "slot": slot,
                        "resource_id": str(vb.resourceId),
                        "byte_offset": vb.byteOffset,
                        "byte_stride": vb.byteStride,
                        "byte_size": cls._bound_size(vb.byteSize),
                    }
                )
        info["vertex_buffers"] = buffers

        ib = pipe.GetIBuffer()
        if ib.resourceId != rd.ResourceId.Null():
            info["index_buffer"] = {
                "resource_id": str(ib.resourceId),
                "byte_offset": ib.byteOffset,
                "byte_stride": ib.byteStride,
                "byte_size": cls._bound_size(ib.byteSize),
            }
        return info

    @staticmethod
    def _get_d3d11_state(controller):
        """Depth and rasterizer state of the current event"""
        state = controller.GetD3D11PipelineState()
        depth = state.outputMerger.depthStencilState
        raster = state.rasterizer.state
        return {
            "depth_state": {
                "depth_enable": depth.depthEnable,
                "depth_writes": depth.depthWrites,
                "depth_function": str(depth.depthFunction),
                "stencil_enable": depth.stencilEnable,
            },
            "rasterizer": {
                "cull_mode": str(raster.cullMode),
                "fill_mode": str(raster.fillMode),
                "front_ccw": raster.frontCCW,
                "depth_clip": raster.depthClip,
                "scissor_enable": raster.scissorEnable,
            },
        }

    @staticmethod
    def _mark_referenced(shader_info):
        """
        Flag constants the shader code never reads. They stay in the buffer layout but nothing
        has to fill them, so their values are whatever was left in the buffer.
        """
        disassembly = shader_info.get("disassembly")
        if not disassembly:
            return

        variables = []
        for cbuffer in shader_info["constant_buffers"]:
            variables.extend(cbuffer.get("variables", []))
        found = [
            re.search(r"\b%s\b" % re.escape(var["name"]), disassembly) is not None
            for var in variables
        ]
        # No name at all means the disassembly uses raw registers: nothing to conclude
        if any(found):
            for var, referenced in zip(variables, found):
                var["referenced"] = referenced

    @staticmethod
    def _serialize_color_blend(index, blend):
        """Serialize an rd.ColorBlend for one render target"""

        def equation(eq):
            return {
                "source": str(eq.source),
                "destination": str(eq.destination),
                "operation": str(eq.operation),
            }

        return {
            "index": index,
            "enabled": blend.enabled,
            "color": equation(blend.colorBlend),
            "alpha": equation(blend.alphaBlend),
            "write_mask": blend.writeMask,
        }

    def _get_stage_resources(self, controller, pipe, stage, reflection):
        """Get shader resource views (SRVs) for a stage"""
        resources = []
        try:
            srvs = pipe.GetReadOnlyResources(stage, False)

            name_map = {}
            if reflection:
                for res in reflection.readOnlyResources:
                    name_map[res.fixedBindNumber] = res.name

            for srv in srvs:
                if srv.descriptor.resource == rd.ResourceId.Null():
                    continue

                slot = srv.access.index
                res_info = {
                    "slot": slot,
                    "name": name_map.get(slot, ""),
                    "resource_id": str(srv.descriptor.resource),
                }

                res_info.update(
                    self._get_resource_details(controller, srv.descriptor.resource)
                )

                res_info["first_mip"] = srv.descriptor.firstMip
                res_info["num_mips"] = srv.descriptor.numMips
                res_info["first_slice"] = srv.descriptor.firstSlice
                res_info["num_slices"] = srv.descriptor.numSlices

                resources.append(res_info)
        except Exception as e:
            resources.append({"error": str(e)})

        return resources

    def _get_stage_uavs(self, controller, pipe, stage, reflection):
        """Get unordered access views (UAVs) for a stage"""
        uavs = []
        try:
            uav_list = pipe.GetReadWriteResources(stage, False)

            name_map = {}
            if reflection:
                for res in reflection.readWriteResources:
                    name_map[res.fixedBindNumber] = res.name

            for uav in uav_list:
                if uav.descriptor.resource == rd.ResourceId.Null():
                    continue

                slot = uav.access.index
                uav_info = {
                    "slot": slot,
                    "name": name_map.get(slot, ""),
                    "resource_id": str(uav.descriptor.resource),
                }

                uav_info.update(
                    self._get_resource_details(controller, uav.descriptor.resource)
                )

                uav_info["first_mip"] = uav.descriptor.firstMip
                uav_info["num_mips"] = uav.descriptor.numMips
                uav_info["byte_offset"] = uav.descriptor.byteOffset
                uav_info["byte_size"] = uav.descriptor.byteSize

                uavs.append(uav_info)
        except Exception as e:
            uavs.append({"error": str(e)})

        return uavs

    def _get_stage_samplers(self, pipe, stage, reflection):
        """Get samplers for a stage"""
        samplers = []
        try:
            sampler_list = pipe.GetSamplers(stage, False)

            name_map = {}
            if reflection:
                for samp in reflection.samplers:
                    name_map[samp.fixedBindNumber] = samp.name

            for samp in sampler_list:
                slot = samp.access.index
                samp_info = {
                    "slot": slot,
                    "name": name_map.get(slot, ""),
                }

                # RenderDoc 1.32+: GetSamplers returns UsedDescriptor; sampler state lives in
                # .sampler (SamplerDescriptor), .descriptor is the (empty) resource descriptor.
                desc = getattr(samp, "sampler", None) or samp.descriptor
                samp_info.update(self._serialize_sampler(desc))
                samplers.append(samp_info)
        except Exception as e:
            samplers.append({"error": str(e)})

        return samplers

    @staticmethod
    def _serialize_sampler(desc):
        """Serialize an rd.SamplerDescriptor (attribute names differ across RenderDoc versions)"""
        info = {}

        def enum(value):
            return str(value).split(".")[-1]

        for key in ("addressU", "addressV", "addressW"):
            if hasattr(desc, key):
                info[key] = enum(getattr(desc, key))
        flt = getattr(desc, "filter", None)
        if flt is not None:
            if hasattr(flt, "minify"):
                info["filter"] = {
                    "minify": enum(flt.minify),
                    "magnify": enum(flt.magnify),
                    "mip": enum(flt.mip),
                    "function": enum(flt.filter),
                }
            else:
                info["filter"] = str(flt)
        for key, out in (
            ("maxAnisotropy", "max_anisotropy"),
            ("minLOD", "min_lod"),
            ("maxLOD", "max_lod"),
            ("mipBias", "mip_lod_bias"),
            ("mipLODBias", "mip_lod_bias"),
        ):
            if hasattr(desc, key):
                info[out] = getattr(desc, key)
        border = getattr(desc, "borderColorValue", None)
        if border is not None and hasattr(border, "floatValue"):
            info["border_color"] = list(border.floatValue)
        elif hasattr(desc, "borderColor"):
            try:
                info["border_color"] = list(desc.borderColor)
            except TypeError:
                pass
        if hasattr(desc, "compareFunction"):
            info["compare_function"] = enum(desc.compareFunction)
        return info

    def _get_stage_cbuffers(self, controller, pipe, stage, reflection):
        """Get constant buffers for a stage from shader reflection"""
        cbuffers = []
        try:
            if not reflection:
                return cbuffers

            for cb in reflection.constantBlocks:
                slot = cb.bindPoint if hasattr(cb, 'bindPoint') else cb.fixedBindNumber
                cb_info = {
                    "slot": slot,
                    "name": cb.name,
                    "byte_size": cb.byteSize,
                    "variable_count": len(cb.variables) if cb.variables else 0,
                    "variables": [],
                }
                if cb.variables:
                    for var in cb.variables:
                        cb_info["variables"].append({
                            "name": var.name,
                            "byte_offset": var.byteOffset,
                            "type": str(var.type.name) if var.type else "",
                        })
                cbuffers.append(cb_info)

        except Exception as e:
            cbuffers.append({"error": str(e)})

        return cbuffers

    def _get_resource_details(self, controller, resource_id):
        """Get details about a resource (texture or buffer)"""
        details = {}

        try:
            resource_name = self.ctx.GetResourceName(resource_id)
            if resource_name:
                details["resource_name"] = resource_name
        except Exception:
            pass

        for tex in controller.GetTextures():
            if tex.resourceId == resource_id:
                details["type"] = "texture"
                details["width"] = tex.width
                details["height"] = tex.height
                details["depth"] = tex.depth
                details["array_size"] = tex.arraysize
                details["mip_levels"] = tex.mips
                details["format"] = str(tex.format.Name())
                details["dimension"] = str(tex.type)
                details["msaa_samples"] = tex.msSamp
                return details

        for buf in controller.GetBuffers():
            if buf.resourceId == resource_id:
                details["type"] = "buffer"
                details["length"] = buf.length
                return details

        return details

    def _get_cbuffer_info(self, controller, pipe, reflection, stage):
        """Get constant buffer information and values"""
        cbuffers = []

        for i, cb in enumerate(reflection.constantBlocks):
            cb_info = {
                "name": cb.name,
                "slot": getattr(cb, "fixedBindNumber", i),
                "size": cb.byteSize,
                "variables": [],
            }

            try:
                # RenderDoc 1.32+: GetConstantBlock returns a UsedDescriptor
                if hasattr(pipe, "GetConstantBlock"):
                    desc = pipe.GetConstantBlock(stage, i, 0).descriptor
                    buffer_id, offset, size = desc.resource, desc.byteOffset, desc.byteSize
                else:
                    bind = pipe.GetConstantBuffer(stage, i, 0)
                    buffer_id, offset, size = bind.resourceId, bind.byteOffset, bind.byteSize
                if buffer_id != rd.ResourceId.Null():
                    cb_info["resource_id"] = str(buffer_id)
                    cb_info["byte_offset"] = offset
                    variables = controller.GetCBufferVariableContents(
                        pipe.GetGraphicsPipelineObject(),
                        reflection.resourceId,
                        stage,
                        reflection.entryPoint,
                        i,
                        buffer_id,
                        offset,
                        size,
                    )
                    cb_info["variables"] = Serializers.serialize_variables(variables)
            except Exception as e:
                cb_info["error"] = str(e)

            cbuffers.append(cb_info)

        return cbuffers

    def _get_resource_bindings(self, reflection):
        """Get shader resource bindings"""
        resources = []

        try:
            for res in reflection.readOnlyResources:
                resources.append(
                    {
                        "name": res.name,
                        "type": str(res.resType),
                        "binding": res.fixedBindNumber,
                        "access": "ReadOnly",
                    }
                )
        except Exception:
            pass

        try:
            for res in reflection.readWriteResources:
                resources.append(
                    {
                        "name": res.name,
                        "type": str(res.resType),
                        "binding": res.fixedBindNumber,
                        "access": "ReadWrite",
                    }
                )
        except Exception:
            pass

        return resources
