"""
Common helper functions for RenderDoc operations.
"""

import renderdoc as rd


class Helpers:
    """Common helper functions (static methods)"""

    @staticmethod
    def flatten_actions(actions):
        """Flatten hierarchical actions to a list"""
        flat = []
        for action in actions:
            flat.append(action)
            if action.children:
                flat.extend(Helpers.flatten_actions(action.children))
        return flat

    @staticmethod
    def count_children(action):
        """Count total number of children recursively"""
        count = 0
        if action.children:
            for child in action.children:
                count += 1
                count += Helpers.count_children(child)
        return count

    @staticmethod
    def get_all_shader_stages():
        """Get list of all shader stages"""
        return [
            rd.ShaderStage.Vertex,
            rd.ShaderStage.Hull,
            rd.ShaderStage.Domain,
            rd.ShaderStage.Geometry,
            rd.ShaderStage.Pixel,
            rd.ShaderStage.Compute,
        ]
