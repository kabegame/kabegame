"""
Request Handler for RenderDoc MCP Bridge
Routes incoming requests to appropriate facade methods.
"""

import traceback


class RequestHandler:
    """Handles incoming MCP bridge requests"""

    def __init__(self, facade):
        self.facade = facade
        self._methods = {
            "ping": self._handle_ping,
            "get_capture_status": self._handle_get_capture_status,
            "get_draw_calls": self._handle_get_draw_calls,
            "get_frame_summary": self._handle_get_frame_summary,
            "find_draws_by_shader": self._handle_find_draws_by_shader,
            "find_draws_by_texture": self._handle_find_draws_by_texture,
            "find_draws_by_resource": self._handle_find_draws_by_resource,
            "get_draw_call_details": self._handle_get_draw_call_details,
            "get_action_timings": self._handle_get_action_timings,
            "get_shader_info": self._handle_get_shader_info,
            "get_buffer_contents": self._handle_get_buffer_contents,
            "get_mesh_data": self._handle_get_mesh_data,
            "get_texture_info": self._handle_get_texture_info,
            "get_texture_data": self._handle_get_texture_data,
            "save_texture": self._handle_save_texture,
            "pick_pixel": self._handle_pick_pixel,
            "get_texture_stats": self._handle_get_texture_stats,
            "get_pipeline_state": self._handle_get_pipeline_state,
            "list_captures": self._handle_list_captures,
            "open_capture": self._handle_open_capture,
            "close_capture": self._handle_close_capture,
            # 第 3 批：抓帧控制（target.py），连 RenderDoc 注入在 WPE 里的目标，一律不抢占
            "target_find": self._handle_target_find,
            "target_status": self._handle_target_status,
            "target_capture": self._handle_target_capture,
            "target_inspect": self._handle_target_inspect,
        }

    def handle(self, request):
        """Handle a request and return response"""
        request_id = request.get("id")
        method = request.get("method")
        params = request.get("params", {})

        try:
            if method not in self._methods:
                return self._error_response(
                    request_id, -32601, "Method not found: %s" % method
                )

            result = self._methods[method](params)
            return {"id": request_id, "result": result}

        except ValueError as e:
            return self._error_response(request_id, -32602, str(e))
        except Exception as e:
            traceback.print_exc()
            return self._error_response(request_id, -32000, str(e))

    def _error_response(self, request_id, code, message):
        """Create an error response"""
        return {"id": request_id, "error": {"code": code, "message": message}}

    def _handle_ping(self, params):
        """Handle ping request"""
        return {"status": "ok", "message": "pong"}

    def _handle_get_capture_status(self, params):
        """Handle get_capture_status request"""
        return self.facade.get_capture_status()

    def _handle_get_draw_calls(self, params):
        """Handle get_draw_calls request"""
        include_children = params.get("include_children", True)
        marker_filter = params.get("marker_filter")
        exclude_markers = params.get("exclude_markers")
        event_id_min = params.get("event_id_min")
        event_id_max = params.get("event_id_max")
        only_actions = params.get("only_actions", False)
        flags_filter = params.get("flags_filter")
        return self.facade.get_draw_calls(
            include_children=include_children,
            marker_filter=marker_filter,
            exclude_markers=exclude_markers,
            event_id_min=event_id_min,
            event_id_max=event_id_max,
            only_actions=only_actions,
            flags_filter=flags_filter,
        )

    def _handle_get_frame_summary(self, params):
        """Handle get_frame_summary request"""
        return self.facade.get_frame_summary()

    def _handle_find_draws_by_shader(self, params):
        """Handle find_draws_by_shader request"""
        shader_name = params.get("shader_name")
        if shader_name is None:
            raise ValueError("shader_name is required")
        stage = params.get("stage")
        return self.facade.find_draws_by_shader(shader_name, stage)

    def _handle_find_draws_by_texture(self, params):
        """Handle find_draws_by_texture request"""
        texture_name = params.get("texture_name")
        if texture_name is None:
            raise ValueError("texture_name is required")
        return self.facade.find_draws_by_texture(texture_name)

    def _handle_find_draws_by_resource(self, params):
        """Handle find_draws_by_resource request"""
        resource_id = params.get("resource_id")
        if resource_id is None:
            raise ValueError("resource_id is required")
        return self.facade.find_draws_by_resource(resource_id)

    def _handle_get_draw_call_details(self, params):
        """Handle get_draw_call_details request"""
        event_id = params.get("event_id")
        if event_id is None:
            raise ValueError("event_id is required")
        return self.facade.get_draw_call_details(int(event_id))

    def _handle_get_action_timings(self, params):
        """Handle get_action_timings request"""
        event_ids = params.get("event_ids")
        marker_filter = params.get("marker_filter")
        exclude_markers = params.get("exclude_markers")
        return self.facade.get_action_timings(
            event_ids=event_ids,
            marker_filter=marker_filter,
            exclude_markers=exclude_markers,
        )

    def _handle_get_shader_info(self, params):
        """Handle get_shader_info request"""
        event_id = params.get("event_id")
        stage = params.get("stage")
        if event_id is None:
            raise ValueError("event_id is required")
        if stage is None:
            raise ValueError("stage is required")
        return self.facade.get_shader_info(int(event_id), stage)

    def _handle_get_buffer_contents(self, params):
        """Handle get_buffer_contents request"""
        resource_id = params.get("resource_id")
        if resource_id is None:
            raise ValueError("resource_id is required")
        offset = params.get("offset", 0)
        length = params.get("length", 0)
        event_id = params.get("event_id")
        max_bytes = params.get("max_bytes")
        return self.facade.get_buffer_contents(
            resource_id,
            offset,
            length,
            None if event_id is None else int(event_id),
            params.get("output_path"),
            None if max_bytes is None else int(max_bytes),
        )

    def _handle_get_mesh_data(self, params):
        """Handle get_mesh_data request"""
        event_id = params.get("event_id")
        if event_id is None:
            raise ValueError("event_id is required")
        max_vertices = params.get("max_vertices")
        return self.facade.get_mesh_data(
            int(event_id),
            params.get("stage", "vs_in"),
            int(params.get("first", 0)),
            int(params.get("count", 0)),
            int(params.get("instance", 0)),
            params.get("output_path"),
            None if max_vertices is None else int(max_vertices),
        )

    def _handle_get_texture_info(self, params):
        """Handle get_texture_info request"""
        resource_id = params.get("resource_id")
        if resource_id is None:
            raise ValueError("resource_id is required")
        return self.facade.get_texture_info(resource_id)

    def _handle_get_texture_data(self, params):
        """Handle get_texture_data request"""
        resource_id = params.get("resource_id")
        if resource_id is None:
            raise ValueError("resource_id is required")
        mip = params.get("mip", 0)
        slice_idx = params.get("slice", 0)
        sample = params.get("sample", 0)
        depth_slice = params.get("depth_slice")  # None = full volume
        event_id = params.get("event_id")
        max_bytes = params.get("max_bytes")
        return self.facade.get_texture_data(
            resource_id,
            mip,
            slice_idx,
            sample,
            depth_slice,
            None if event_id is None else int(event_id),
            None if max_bytes is None else int(max_bytes),
        )

    def _handle_save_texture(self, params):
        """Handle save_texture request"""
        resource_id = params.get("resource_id")
        if resource_id is None:
            raise ValueError("resource_id is required")
        output_path = params.get("output_path")
        if output_path is None:
            raise ValueError("output_path is required")
        event_id = params.get("event_id")
        return self.facade.save_texture(
            resource_id,
            output_path,
            None if event_id is None else int(event_id),
            int(params.get("mip", 0)),
            int(params.get("slice", 0)),
            int(params.get("sample", 0)),
            params.get("file_type"),
            params.get("alpha", "preserve"),
        )

    def _handle_pick_pixel(self, params):
        """Handle pick_pixel request"""
        resource_id = params.get("resource_id")
        if resource_id is None:
            raise ValueError("resource_id is required")
        if params.get("x") is None or params.get("y") is None:
            raise ValueError("x and y are required")
        event_id = params.get("event_id")
        return self.facade.pick_pixel(
            resource_id,
            int(params["x"]),
            int(params["y"]),
            None if event_id is None else int(event_id),
            int(params.get("mip", 0)),
            int(params.get("slice", 0)),
            int(params.get("sample", 0)),
        )

    def _handle_get_texture_stats(self, params):
        """Handle get_texture_stats request"""
        resource_id = params.get("resource_id")
        if resource_id is None:
            raise ValueError("resource_id is required")
        event_id = params.get("event_id")
        return self.facade.get_texture_stats(
            resource_id,
            None if event_id is None else int(event_id),
            int(params.get("mip", 0)),
            int(params.get("slice", 0)),
            int(params.get("sample", 0)),
        )

    def _handle_get_pipeline_state(self, params):
        """Handle get_pipeline_state request"""
        event_id = params.get("event_id")
        if event_id is None:
            raise ValueError("event_id is required")
        return self.facade.get_pipeline_state(int(event_id))

    def _handle_list_captures(self, params):
        """Handle list_captures request"""
        directory = params.get("directory")
        if directory is None:
            raise ValueError("directory is required")
        return self.facade.list_captures(directory, bool(params.get("recursive", False)))

    def _handle_open_capture(self, params):
        """Handle open_capture request"""
        capture_path = params.get("capture_path")
        if capture_path is None:
            raise ValueError("capture_path is required")
        return self.facade.open_capture(capture_path)

    def _handle_close_capture(self, params):
        """关掉本工作进程打开的抓帧（ctx 是 context.ReplayContext）"""
        closed = self.facade.ctx.close()
        return {"success": True, "closed": closed}

    # ==================== 抓帧控制（第 3 批） ====================

    @staticmethod
    def _target():
        # 只在 qrenderdoc 里能 import（要 renderdoc 模块），用到时再导入
        from . import target
        return target

    def _handle_target_find(self, params):
        """按进程号找目标号"""
        if params.get("pid") is None:
            raise ValueError("pid is required")
        t = self._target()
        return t.target_find(int(params["pid"]), float(params.get("timeout", 10)),
                             params.get("client") or t.DEFAULT_CLIENT)

    def _handle_target_status(self, params):
        """API、是否在呈现、可抓窗口数"""
        if params.get("ident") is None:
            raise ValueError("ident is required")
        t = self._target()
        return t.target_status(int(params["ident"]), params.get("client") or t.DEFAULT_CLIENT,
                               float(params.get("settle", 1.5)))

    def _handle_target_capture(self, params):
        """不抢占地连目标、认出自己的窗口、抓 N 帧、逐张核对"""
        for key in ("ident", "frames", "expect_size", "template"):
            if params.get(key) is None:
                raise ValueError("%s is required" % key)
        t = self._target()
        return t.target_capture(int(params["ident"]), int(params["frames"]), params["expect_size"],
                                params["template"], params.get("others") or [],
                                float(params.get("timeout", 60)), params.get("client") or t.DEFAULT_CLIENT,
                                float(params.get("probe_timeout", 30)), params.get("desktop") or [],
                                params.get("test_windows"), int(params.get("size_tol", t.SIZE_TOL)),
                                int(params.get("thumb_tol", t.THUMB_TOL)))

    def _handle_target_inspect(self, params):
        """另开一个回放读一张抓帧，不动当前打开的抓帧"""
        path = params.get("path")
        if path is None:
            raise ValueError("path is required")
        return self._target().inspect(path)
