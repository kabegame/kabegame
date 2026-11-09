"""
Serialization utility functions for RenderDoc data types.
"""

import renderdoc as rd


# rd.VarType member -> ShaderValue array. Looked up by name because the members differ across
# RenderDoc versions (Int became SInt) and a missing one must not lose the values of the others.
VALUE_ARRAYS = (
    ("Float", "f32v"),
    ("Half", "f16v"),
    ("Double", "f64v"),
    ("SInt", "s32v"),
    ("Int", "s32v"),
    ("UInt", "u32v"),
    ("Bool", "u32v"),
    ("SShort", "s16v"),
    ("UShort", "u16v"),
    ("SByte", "s8v"),
    ("UByte", "u8v"),
    ("SLong", "s64v"),
    ("ULong", "u64v"),
)


class Serializers:
    """Serialization utility functions (static methods)"""

    @staticmethod
    def serialize_flags(flags):
        """Convert ActionFlags to list of strings"""
        flag_names = []
        flag_map = [
            (rd.ActionFlags.Drawcall, "Drawcall"),
            (rd.ActionFlags.Dispatch, "Dispatch"),
            (rd.ActionFlags.Clear, "Clear"),
            (rd.ActionFlags.PushMarker, "PushMarker"),
            (rd.ActionFlags.PopMarker, "PopMarker"),
            (rd.ActionFlags.SetMarker, "SetMarker"),
            (rd.ActionFlags.Present, "Present"),
            (rd.ActionFlags.Copy, "Copy"),
            (rd.ActionFlags.Resolve, "Resolve"),
            (rd.ActionFlags.GenMips, "GenMips"),
            (rd.ActionFlags.PassBoundary, "PassBoundary"),
            (rd.ActionFlags.Indexed, "Indexed"),
            (rd.ActionFlags.Instanced, "Instanced"),
            (rd.ActionFlags.Auto, "Auto"),
            (rd.ActionFlags.Indirect, "Indirect"),
            (rd.ActionFlags.ClearColor, "ClearColor"),
            (rd.ActionFlags.ClearDepthStencil, "ClearDepthStencil"),
            (rd.ActionFlags.BeginPass, "BeginPass"),
            (rd.ActionFlags.EndPass, "EndPass"),
        ]
        for flag, name in flag_map:
            if flags & flag:
                flag_names.append(name)
        return flag_names

    @staticmethod
    def serialize_variables(variables):
        """Serialize shader variables to JSON format"""
        arrays = {
            getattr(rd.VarType, member): array
            for member, array in VALUE_ARRAYS
            if hasattr(rd.VarType, member)
        }

        result = []
        for var in variables:
            var_info = {
                "name": var.name,
                "type": str(var.type),
                "rows": var.rows,
                "columns": var.columns,
            }
            if var.rows > 1 and hasattr(var, "RowMajor"):
                var_info["row_major"] = var.RowMajor()

            # Get value based on type
            array = arrays.get(var.type)
            if array:
                try:
                    count = var.rows * var.columns
                    var_info["value"] = list(getattr(var.value, array)[:count])
                except Exception as e:
                    var_info["value_error"] = str(e)

            # Nested members
            if var.members:
                var_info["members"] = Serializers.serialize_variables(var.members)

            result.append(var_info)

        return result

    @staticmethod
    def serialize_actions(
        actions,
        structured_file,
        include_children,
        marker_filter=None,
        exclude_markers=None,
        event_id_min=None,
        event_id_max=None,
        only_actions=False,
        flags_filter=None,
        _in_matching_marker=False,
    ):
        """
        Serialize action list to JSON-compatible format with filtering.

        Args:
            actions: List of actions to serialize
            structured_file: Structured file for action names
            include_children: Include child actions in hierarchy
            marker_filter: Only include actions under markers containing this string
            exclude_markers: Exclude actions under markers containing these strings
            event_id_min: Only include actions with event_id >= this value
            event_id_max: Only include actions with event_id <= this value
            only_actions: Exclude marker actions (PushMarker/PopMarker/SetMarker)
            flags_filter: Only include actions with these flags
            _in_matching_marker: Internal flag for marker_filter recursion
        """
        serialized = []

        # Build flags filter set for efficient lookup
        flags_filter_set = None
        if flags_filter:
            flags_filter_set = set(flags_filter)

        for action in actions:
            name = action.GetName(structured_file)
            flags = action.flags

            # Check if this is a marker
            is_push_marker = flags & rd.ActionFlags.PushMarker
            is_set_marker = flags & rd.ActionFlags.SetMarker
            is_pop_marker = flags & rd.ActionFlags.PopMarker
            is_marker = is_push_marker or is_set_marker or is_pop_marker

            # 1. exclude_markers check - skip this marker and all its children
            if exclude_markers and is_marker:
                if any(ex in name for ex in exclude_markers):
                    continue

            # 2. marker_filter check - track if we're inside a matching marker
            in_matching = _in_matching_marker
            if marker_filter:
                if is_push_marker and marker_filter in name:
                    in_matching = True

            # 3. Determine if action passes event_id range filter
            # For markers with children, we check children even if marker is outside range
            in_range = True
            if not is_marker:
                if event_id_min is not None and action.eventId < event_id_min:
                    in_range = False
                if event_id_max is not None and action.eventId > event_id_max:
                    in_range = False

            # 4. only_actions check - skip markers but process their children
            if only_actions and is_marker:
                if include_children and action.children:
                    child_actions = Serializers.serialize_actions(
                        action.children,
                        structured_file,
                        include_children,
                        marker_filter=marker_filter,
                        exclude_markers=exclude_markers,
                        event_id_min=event_id_min,
                        event_id_max=event_id_max,
                        only_actions=only_actions,
                        flags_filter=flags_filter,
                        _in_matching_marker=in_matching,
                    )
                    serialized.extend(child_actions)
                continue

            # 5. flags_filter check - only for non-markers
            if flags_filter_set and not is_marker:
                flag_names = Serializers.serialize_flags(flags)
                if not any(f in flags_filter_set for f in flag_names):
                    continue

            # 6. Check if this action should be included based on marker_filter
            passes_marker_filter = not marker_filter or in_matching

            # 7. For markers with children, check if any children pass filters
            children_result = []
            has_passing_children = False
            if include_children and action.children:
                children_result = Serializers.serialize_actions(
                    action.children,
                    structured_file,
                    include_children,
                    marker_filter=marker_filter,
                    exclude_markers=exclude_markers,
                    event_id_min=event_id_min,
                    event_id_max=event_id_max,
                    only_actions=only_actions,
                    flags_filter=flags_filter,
                    _in_matching_marker=in_matching,
                )
                has_passing_children = len(children_result) > 0

            # Include the action if:
            # - It passes all filters (for leaf actions)
            # - It's a marker with children that pass filters (to maintain hierarchy)
            should_include = False
            if is_marker:
                # Include marker if it has children that pass filters
                should_include = has_passing_children and passes_marker_filter
            else:
                # Include leaf action if it passes all filters
                should_include = in_range and passes_marker_filter

            if should_include:
                flag_names = Serializers.serialize_flags(flags)
                item = {
                    "event_id": action.eventId,
                    "action_id": action.actionId,
                    "name": name,
                    "flags": flag_names,
                    "num_indices": action.numIndices,
                    "num_instances": action.numInstances,
                }
                if children_result:
                    item["children"] = children_result
                serialized.append(item)

        return serialized
