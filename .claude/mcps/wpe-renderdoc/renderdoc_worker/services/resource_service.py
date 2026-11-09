"""
Resource information service for RenderDoc.
"""

import base64
import os

import renderdoc as rd

from ..utils import Parsers

# Raw bytes get_texture_data returns before refusing (base64 inflates by 4/3).
# Larger reads should go through save_texture / pick_pixel / get_texture_stats.
DEFAULT_MAX_TEXTURE_BYTES = 64 * 1024
# Same limit for get_buffer_contents; larger reads should pass output_path.
DEFAULT_MAX_BUFFER_BYTES = 64 * 1024

# save_texture output formats -> rd.FileType member names
SAVE_FILE_TYPES = {
    "png": "PNG",
    "exr": "EXR",
    "dds": "DDS",
    "hdr": "HDR",
    "jpg": "JPG",
    "bmp": "BMP",
    "tga": "TGA",
}
# Formats that cannot carry alpha
NO_ALPHA_FILE_TYPES = ("jpg", "bmp", "hdr")


class ResourceService:
    """Resource information service"""

    def __init__(self, ctx, invoke_fn):
        self.ctx = ctx
        self._invoke = invoke_fn

    def _find_texture_by_id(self, controller, resource_id):
        """Find texture by resource ID"""
        target_id = Parsers.extract_numeric_id(resource_id)
        for tex in controller.GetTextures():
            tex_id_str = str(tex.resourceId)
            tex_id = Parsers.extract_numeric_id(tex_id_str)
            if tex_id == target_id:
                return tex
        return None

    def _texture_subresource(self, controller, resource_id, event_id, mip, slice, sample):
        """
        Move replay to event_id (if given), then find and validate a texture subresource.

        Texture contents depend on the replayed event, so reads of render targets must
        pin the event. Returns (tex_desc, subresource, error).
        """
        if event_id is not None:
            controller.SetFrameEvent(int(event_id), True)

        tex_desc = self._find_texture_by_id(controller, resource_id)
        if not tex_desc:
            return None, None, "Texture not found: %s" % resource_id

        if mip < 0 or mip >= tex_desc.mips:
            return None, None, "Invalid mip level %d (texture has %d mips)" % (mip, tex_desc.mips)

        max_slices = tex_desc.arraysize
        if tex_desc.cubemap:
            max_slices = tex_desc.arraysize * 6
        if slice < 0 or (max_slices > 1 and slice >= max_slices):
            return None, None, "Invalid slice %d (texture has %d slices)" % (slice, max_slices)

        if sample < 0 or (tex_desc.msSamp > 1 and sample >= tex_desc.msSamp):
            return None, None, "Invalid sample %d (texture has %d samples)" % (sample, tex_desc.msSamp)

        sub = rd.Subresource()
        sub.mip = mip
        sub.slice = slice
        sub.sample = sample
        return tex_desc, sub, None

    @staticmethod
    def _pixel_value(value):
        """Serialize an rd.PixelValue"""
        return {
            "float": list(value.floatValue),
            "uint": list(value.uintValue),
            "int": list(value.intValue),
        }

    def get_buffer_contents(
        self,
        resource_id,
        offset=0,
        length=0,
        event_id=None,
        output_path=None,
        max_bytes=DEFAULT_MAX_BUFFER_BYTES,
    ):
        """
        Get buffer data.

        Dynamic buffers change within a frame, so pass event_id to read them at a given event;
        without it the read sees whatever event replay was last moved to.
        output_path writes the raw bytes to a file instead of returning them.
        """
        if not self.ctx.IsCaptureLoaded():
            raise ValueError("No capture loaded")
        if output_path is not None and not os.path.isabs(output_path):
            raise ValueError("output_path must be an absolute path: %s" % output_path)

        result = {"data": None, "error": None}

        def callback(controller):
            if event_id is not None:
                controller.SetFrameEvent(int(event_id), True)

            # Parse resource ID (match by number, like textures: rd.ResourceId has no
            # settable id in newer RenderDoc)
            try:
                target_id = Parsers.extract_numeric_id(resource_id)
            except Exception:
                result["error"] = "Invalid resource ID: %s" % resource_id
                return

            # Find buffer
            buf_desc = None
            for buf in controller.GetBuffers():
                if Parsers.extract_numeric_id(str(buf.resourceId)) == target_id:
                    buf_desc = buf
                    break
            rid = buf_desc.resourceId if buf_desc else None

            if not buf_desc:
                result["error"] = "Buffer not found: %s" % resource_id
                return

            # Get data (length 0 reads to the end of the buffer)
            data = controller.GetBufferData(rid, offset, length)

            info = {
                "resource_id": resource_id,
                "event_id": event_id,
                "length": len(data),
                "total_size": buf_desc.length,
                "offset": offset,
            }

            if output_path is not None:
                directory = os.path.dirname(output_path)
                if directory:
                    os.makedirs(directory, exist_ok=True)
                with open(output_path, "wb") as f:
                    f.write(bytes(data))
                info["path"] = output_path
            elif max_bytes and len(data) > max_bytes:
                result["error"] = (
                    "Buffer data is %d bytes, over max_bytes=%d. Pass output_path to write it "
                    "to a file, or get_mesh_data for decoded vertices." % (len(data), max_bytes)
                )
                return
            else:
                info["content_base64"] = base64.b64encode(data).decode("ascii")

            result["data"] = info

        self._invoke(callback)

        if result["error"]:
            raise ValueError(result["error"])
        return result["data"]

    def get_texture_info(self, resource_id):
        """Get texture metadata"""
        if not self.ctx.IsCaptureLoaded():
            raise ValueError("No capture loaded")

        result = {"texture": None, "error": None}

        def callback(controller):
            try:
                tex_desc = self._find_texture_by_id(controller, resource_id)

                if not tex_desc:
                    result["error"] = "Texture not found: %s" % resource_id
                    return

                result["texture"] = {
                    "resource_id": resource_id,
                    "width": tex_desc.width,
                    "height": tex_desc.height,
                    "depth": tex_desc.depth,
                    "array_size": tex_desc.arraysize,
                    "mip_levels": tex_desc.mips,
                    "format": str(tex_desc.format.Name()),
                    "dimension": str(tex_desc.type),
                    "msaa_samples": tex_desc.msSamp,
                    "byte_size": tex_desc.byteSize,
                }
            except Exception as e:
                import traceback
                result["error"] = "Error: %s\n%s" % (str(e), traceback.format_exc())

        self._invoke(callback)

        if result["error"]:
            raise ValueError(result["error"])
        return result["texture"]

    def get_texture_data(
        self,
        resource_id,
        mip=0,
        slice=0,
        sample=0,
        depth_slice=None,
        event_id=None,
        max_bytes=DEFAULT_MAX_TEXTURE_BYTES,
    ):
        """Get texture pixel data."""
        if not self.ctx.IsCaptureLoaded():
            raise ValueError("No capture loaded")

        result = {"data": None, "error": None}

        def callback(controller):
            tex_desc, sub, error = self._texture_subresource(
                controller, resource_id, event_id, mip, slice, sample
            )
            if error:
                result["error"] = error
                return

            # Calculate dimensions at this mip level
            mip_width = max(1, tex_desc.width >> mip)
            mip_height = max(1, tex_desc.height >> mip)
            mip_depth = max(1, tex_desc.depth >> mip)

            # Validate depth_slice for 3D textures
            is_3d = tex_desc.depth > 1
            if depth_slice is not None:
                if not is_3d:
                    result["error"] = "depth_slice can only be used with 3D textures"
                    return
                if depth_slice < 0 or depth_slice >= mip_depth:
                    result["error"] = "Invalid depth_slice %d (texture has %d depth at mip %d)" % (
                        depth_slice,
                        mip_depth,
                        mip,
                    )
                    return

            # Get texture data
            try:
                data = controller.GetTextureData(tex_desc.resourceId, sub)
            except Exception as e:
                result["error"] = "Failed to get texture data: %s" % str(e)
                return

            # Extract depth slice for 3D textures if requested
            output_depth = mip_depth
            if is_3d and depth_slice is not None:
                total_size = len(data)
                bytes_per_slice = total_size // mip_depth
                slice_start = depth_slice * bytes_per_slice
                slice_end = slice_start + bytes_per_slice
                data = data[slice_start:slice_end]
                output_depth = 1

            if max_bytes and len(data) > max_bytes:
                result["error"] = (
                    "Texture data is %d bytes, over max_bytes=%d. Use save_texture to write "
                    "it to a file, or pick_pixel / get_texture_stats for values."
                    % (len(data), max_bytes)
                )
                return

            result["data"] = {
                "event_id": event_id,
                "resource_id": resource_id,
                "width": mip_width,
                "height": mip_height,
                "depth": output_depth,
                "mip": mip,
                "slice": slice,
                "sample": sample,
                "depth_slice": depth_slice,
                "format": str(tex_desc.format.Name()),
                "dimension": str(tex_desc.type),
                "is_3d": is_3d,
                "total_depth": mip_depth if is_3d else 1,
                "data_length": len(data),
                "content_base64": base64.b64encode(data).decode("ascii"),
            }

        self._invoke(callback)

        if result["error"]:
            raise ValueError(result["error"])
        return result["data"]

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
        """
        Save a texture subresource to an image file via ReplayController.SaveTexture.

        file_type defaults to the output_path extension (png when there is none).
        Use exr to keep float formats (e.g. RGBA16F) exact; png/jpg clamp to [0, 1].
        """
        if not self.ctx.IsCaptureLoaded():
            raise ValueError("No capture loaded")
        if not os.path.isabs(output_path):
            raise ValueError("output_path must be an absolute path: %s" % output_path)

        ext = (file_type or os.path.splitext(output_path)[1].lstrip(".") or "png").lower()
        if ext not in SAVE_FILE_TYPES:
            raise ValueError(
                "Unsupported file_type %s (expected one of %s)"
                % (ext, ", ".join(sorted(SAVE_FILE_TYPES)))
            )
        if alpha not in ("preserve", "discard"):
            raise ValueError("alpha must be 'preserve' or 'discard'")

        directory = os.path.dirname(output_path)
        if directory:
            os.makedirs(directory, exist_ok=True)

        result = {"data": None, "error": None}

        def callback(controller):
            tex_desc, sub, error = self._texture_subresource(
                controller, resource_id, event_id, mip, slice, sample
            )
            if error:
                result["error"] = error
                return

            save = rd.TextureSave()
            save.resourceId = tex_desc.resourceId
            save.mip = mip
            save.slice.sliceIndex = slice
            save.sample.sampleIndex = sample
            save.destType = getattr(rd.FileType, SAVE_FILE_TYPES[ext])
            if alpha == "discard" or ext in NO_ALPHA_FILE_TYPES:
                save.alpha = rd.AlphaMapping.Discard
            else:
                save.alpha = rd.AlphaMapping.Preserve

            try:
                status = controller.SaveTexture(save, output_path)
            except Exception as e:
                result["error"] = "SaveTexture failed: %s" % str(e)
                return
            # Older RenderDoc returns bool, newer returns ResultDetails
            ok = status.OK() if hasattr(status, "OK") else bool(status)
            if not ok:
                message = status.Message() if hasattr(status, "Message") else str(status)
                result["error"] = "SaveTexture failed: %s" % message
                return

            result["data"] = {
                "resource_id": resource_id,
                "event_id": event_id,
                "path": output_path,
                "file_type": ext,
                "width": max(1, tex_desc.width >> mip),
                "height": max(1, tex_desc.height >> mip),
                "mip": mip,
                "slice": slice,
                "sample": sample,
                "format": str(tex_desc.format.Name()),
                "file_size": os.path.getsize(output_path) if os.path.exists(output_path) else None,
            }

        self._invoke(callback)

        if result["error"]:
            raise ValueError(result["error"])
        return result["data"]

    def pick_pixel(self, resource_id, x, y, event_id=None, mip=0, slice=0, sample=0):
        """Read one texel (x, y in mip-level pixels, origin top-left) via PickPixel."""
        if not self.ctx.IsCaptureLoaded():
            raise ValueError("No capture loaded")

        result = {"data": None, "error": None}

        def callback(controller):
            tex_desc, sub, error = self._texture_subresource(
                controller, resource_id, event_id, mip, slice, sample
            )
            if error:
                result["error"] = error
                return

            width = max(1, tex_desc.width >> mip)
            height = max(1, tex_desc.height >> mip)
            if x < 0 or x >= width or y < 0 or y >= height:
                result["error"] = "Pixel (%d, %d) outside %dx%d at mip %d" % (x, y, width, height, mip)
                return

            value = controller.PickPixel(tex_desc.resourceId, x, y, sub, rd.CompType.Typeless)
            result["data"] = {
                "resource_id": resource_id,
                "event_id": event_id,
                "x": x,
                "y": y,
                "mip": mip,
                "format": str(tex_desc.format.Name()),
                "value": self._pixel_value(value),
            }

        self._invoke(callback)

        if result["error"]:
            raise ValueError(result["error"])
        return result["data"]

    def get_texture_stats(self, resource_id, event_id=None, mip=0, slice=0, sample=0):
        """Per-channel min / max of a texture subresource via GetMinMax."""
        if not self.ctx.IsCaptureLoaded():
            raise ValueError("No capture loaded")

        result = {"data": None, "error": None}

        def callback(controller):
            tex_desc, sub, error = self._texture_subresource(
                controller, resource_id, event_id, mip, slice, sample
            )
            if error:
                result["error"] = error
                return

            minimum, maximum = controller.GetMinMax(tex_desc.resourceId, sub, rd.CompType.Typeless)
            result["data"] = {
                "resource_id": resource_id,
                "event_id": event_id,
                "width": max(1, tex_desc.width >> mip),
                "height": max(1, tex_desc.height >> mip),
                "mip": mip,
                "format": str(tex_desc.format.Name()),
                "min": self._pixel_value(minimum),
                "max": self._pixel_value(maximum),
            }

        self._invoke(callback)

        if result["error"]:
            raise ValueError(result["error"])
        return result["data"]
