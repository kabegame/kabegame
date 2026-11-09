"""
Parse utility functions for RenderDoc data types.
"""

import renderdoc as rd


class Parsers:
    """Parse utility functions (static methods)"""

    @staticmethod
    def parse_stage(stage_str):
        """Convert stage string to ShaderStage enum"""
        stage_map = {
            "vertex": rd.ShaderStage.Vertex,
            "hull": rd.ShaderStage.Hull,
            "domain": rd.ShaderStage.Domain,
            "geometry": rd.ShaderStage.Geometry,
            "pixel": rd.ShaderStage.Pixel,
            "compute": rd.ShaderStage.Compute,
        }
        stage_lower = stage_str.lower()
        if stage_lower not in stage_map:
            raise ValueError("Unknown shader stage: %s" % stage_str)
        return stage_map[stage_lower]

    @staticmethod
    def parse_resource_id(resource_id_str):
        """Parse resource ID string to ResourceId object"""
        # Handle formats like "ResourceId::123" or just "123"
        rid = rd.ResourceId()
        if "::" in resource_id_str:
            id_part = resource_id_str.split("::")[-1]
        else:
            id_part = resource_id_str
        rid.id = int(id_part)
        return rid

    @staticmethod
    def extract_numeric_id(resource_id_str):
        """Extract numeric ID from resource ID string"""
        if "::" in resource_id_str:
            return int(resource_id_str.split("::")[-1])
        return int(resource_id_str)
