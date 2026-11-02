"""The final ABC that Save YuE2 FLAC + ABC records in the workflow it saves.

ComfyUI embeds the queued workflow in each saved file. That graph predates the
run, so the score the run produced only reaches the save node through a link.
The save node writes it into its own ``properties`` before saving, so opening
the FLAC's workflow shows the score it was saved with.

The queued workflow can still carry an earlier run's score from the open tab.
It is removed when a prompt is queued, so a file saved before the save node
runs never carries a stale score.

Kept free of ComfyUI imports so it can be tested on its own.
"""

PROPERTY = "yue2_abc"
BUNDLE = "bno84.SaveYuE2Bundle"


def _subgraphs(workflow):
    return {graph.get("id"): graph for graph in (workflow.get("definitions") or {}).get("subgraphs") or []
            if isinstance(graph, dict)}


def find_node(workflow, unique_id):
    """The workflow node for a compiled execution ID; "31:6" is node 6 inside subgraph node 31.

    A node inside a subgraph is its definition's node, shared by every instance of that subgraph.
    """
    if not isinstance(workflow, dict):
        return None
    subgraphs = _subgraphs(workflow)
    nodes, node = workflow.get("nodes") or [], None
    for part in str(unique_id).split(":"):
        if node is not None:
            graph = subgraphs.get(node.get("type"))
            if graph is None:
                return None
            nodes = graph.get("nodes") or []
        node = next((n for n in nodes if isinstance(n, dict) and str(n.get("id")) == part), None)
        if node is None:
            return None
    return node


def embed_abc(extra_pnginfo, unique_id, abc):
    """Record the score on the save node in the workflow about to be saved. False when there is none."""
    workflow = extra_pnginfo.get("workflow") if isinstance(extra_pnginfo, dict) else None
    node = find_node(workflow, unique_id)
    if node is None:
        return False
    properties = node.get("properties")
    if not isinstance(properties, dict):
        properties = node["properties"] = {}
    properties[PROPERTY] = abc
    return True


def _bundles(workflow):
    graphs = [workflow, *_subgraphs(workflow).values()]
    for graph in graphs:
        for node in graph.get("nodes") or []:
            if isinstance(node, dict) and node.get("type") == BUNDLE:
                yield node


def workflow_abc(workflow):
    """The score a save node recorded in a saved workflow, or None.

    Queuing strips earlier scores, so one found here is from the run that saved the file.
    """
    if not isinstance(workflow, dict):
        return None
    for node in _bundles(workflow):
        properties = node.get("properties")
        abc = properties.get(PROPERTY) if isinstance(properties, dict) else None
        if isinstance(abc, str) and abc.strip():
            return abc
    return None


def strip_abc(workflow):
    """Remove scores from earlier runs from every save node. Returns how many were removed."""
    if not isinstance(workflow, dict):
        return 0
    removed = 0
    for node in _bundles(workflow):
        properties = node.get("properties")
        if isinstance(properties, dict) and PROPERTY in properties:
            del properties[PROPERTY]
            removed += 1
    return removed


def strip_queued(json_data):
    """On-prompt handler: strip the queued workflow before any node runs."""
    extra = (json_data.get("extra_data") or {}).get("extra_pnginfo") if isinstance(json_data, dict) else None
    if isinstance(extra, dict):
        strip_abc(extra.get("workflow"))
    return json_data
