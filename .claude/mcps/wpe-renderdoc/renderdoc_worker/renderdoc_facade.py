"""
RenderDoc API Facade
Provides thread-safe access to RenderDoc's ReplayController and CaptureContext.
Uses BlockInvoke to marshal calls to the replay thread.
"""

from .services import (
    CaptureManager,
    ActionService,
    SearchService,
    ResourceService,
    PipelineService,
    MeshService,
)


class RenderDocFacade:
    """
    Facade for RenderDoc API access.

    This class delegates all operations to specialized service classes:
    - CaptureManager: Capture management (status, list, open)
    - ActionService: Draw call / action operations
    - SearchService: Reverse lookup searches
    - ResourceService: Texture and buffer data
    - PipelineService: Pipeline state and shader info
    - MeshService: Decoded vertices of a draw
    """

    def __init__(self, ctx):
        """
        Initialize facade with CaptureContext.

        Args:
            ctx: The pyrenderdoc CaptureContext from register()
        """
        self.ctx = ctx

        # Initialize service classes
        self._capture = CaptureManager(ctx, self._invoke)
        self._action = ActionService(ctx, self._invoke)
        self._search = SearchService(ctx, self._invoke)
        self._resource = ResourceService(ctx, self._invoke)
        self._pipeline = PipelineService(ctx, self._invoke)
        self._mesh = MeshService(ctx, self._invoke)

    def _invoke(self, callback):
        """工作进程里没有界面的回放线程：ctx 是 context.ReplayContext，直接把 controller 交给回调"""
        callback(self.ctx.controller)

    # ==================== Capture Management ====================

    def get_capture_status(self):
        """Check if a capture is loaded and get API info"""
        return self._capture.get_capture_status()

    def list_captures(self, directory, recursive=False):
        """List all .rdc files in the specified directory"""
        return self._capture.list_captures(directory, recursive)

    def open_capture(self, capture_path):
        """Open a capture file in RenderDoc"""
        return self._capture.open_capture(capture_path)

    # ==================== Draw Call / Action Operations ====================

    def get_draw_calls(
        self,
        include_children=True,
        marker_filter=None,
        exclude_markers=None,
        event_id_min=None,
        event_id_max=None,
        only_actions=False,
        flags_filter=None,
    ):
        """Get all draw calls/actions in the capture with optional filtering"""
        return self._action.get_draw_calls(
            include_children=include_children,
            marker_filter=marker_filter,
            exclude_markers=exclude_markers,
            event_id_min=event_id_min,
            event_id_max=event_id_max,
            only_actions=only_actions,
            flags_filter=flags_filter,
        )

    def get_frame_summary(self):
        """Get a summary of the current capture frame"""
        return self._action.get_frame_summary()

    def get_draw_call_details(self, event_id):
        """Get detailed information about a specific draw call"""
        return self._action.get_draw_call_details(event_id)

    def get_action_timings(self, event_ids=None, marker_filter=None, exclude_markers=None):
        """Get GPU timing information for actions"""
        return self._action.get_action_timings(
            event_ids=event_ids,
            marker_filter=marker_filter,
            exclude_markers=exclude_markers,
        )

    # ==================== Search Operations ====================

    def find_draws_by_shader(self, shader_name, stage=None):
        """Find all draw calls using a shader with the given name (partial match)"""
        return self._search.find_draws_by_shader(shader_name, stage)

    def find_draws_by_texture(self, texture_name):
        """Find all draw calls using a texture with the given name (partial match)"""
        return self._search.find_draws_by_texture(texture_name)

    def find_draws_by_resource(self, resource_id):
        """Find all draw calls using a specific resource ID (exact match)"""
        return self._search.find_draws_by_resource(resource_id)

    # ==================== Resource Operations ====================

    def get_buffer_contents(
        self, resource_id, offset=0, length=0, event_id=None, output_path=None, max_bytes=None
    ):
        """Get buffer data"""
        kwargs = {}
        if max_bytes is not None:
            kwargs["max_bytes"] = max_bytes
        return self._resource.get_buffer_contents(
            resource_id, offset, length, event_id, output_path, **kwargs
        )

    def get_mesh_data(
        self, event_id, stage="vs_in", first=0, count=0, instance=0, output_path=None, max_vertices=None
    ):
        """Get decoded vertices of a draw"""
        kwargs = {}
        if max_vertices is not None:
            kwargs["max_vertices"] = max_vertices
        return self._mesh.get_mesh_data(
            event_id, stage, first, count, instance, output_path, **kwargs
        )

    def get_texture_info(self, resource_id):
        """Get texture metadata"""
        return self._resource.get_texture_info(resource_id)

    def get_texture_data(
        self, resource_id, mip=0, slice=0, sample=0, depth_slice=None, event_id=None, max_bytes=None
    ):
        """Get texture pixel data"""
        kwargs = {}
        if max_bytes is not None:
            kwargs["max_bytes"] = max_bytes
        return self._resource.get_texture_data(
            resource_id, mip, slice, sample, depth_slice, event_id, **kwargs
        )

    def save_texture(
        self,
        resource_id,
        output_path,
        event_id=None,
        mip=0,
        slice=0,
        sample=0,
        file_type=None,
        alpha="preserve",
    ):
        """Save a texture subresource to an image file"""
        return self._resource.save_texture(
            resource_id, output_path, event_id, mip, slice, sample, file_type, alpha
        )

    def pick_pixel(self, resource_id, x, y, event_id=None, mip=0, slice=0, sample=0):
        """Read one texel"""
        return self._resource.pick_pixel(resource_id, x, y, event_id, mip, slice, sample)

    def get_texture_stats(self, resource_id, event_id=None, mip=0, slice=0, sample=0):
        """Per-channel min / max of a texture subresource"""
        return self._resource.get_texture_stats(resource_id, event_id, mip, slice, sample)

    # ==================== Pipeline Operations ====================

    def get_shader_info(self, event_id, stage):
        """Get shader information for a specific stage"""
        return self._pipeline.get_shader_info(event_id, stage)

    def get_pipeline_state(self, event_id):
        """Get full pipeline state at an event"""
        return self._pipeline.get_pipeline_state(event_id)
