"""
WizMap utility functions extracted from the WizMap library.

Provides:
  - generate_contour_dict: KDE density grid
  - generate_topic_dict: multi-level quadtree topic labels
  - generate_grid_dict: combined grid + topics
  - generate_data_list: ndjson row builder
  - save_json_files: write data.ndjson + grid.json
"""

import json
import numpy as np
from collections import Counter
from os.path import join
from sklearn.feature_extraction.text import CountVectorizer, TfidfTransformer
from sklearn.neighbors import KernelDensity
from scipy.sparse import csr_matrix
from quadtreed3 import Quadtree, Node
from typing import Tuple


def generate_contour_dict(
    xs: list[float],
    ys: list[float],
    grid_size=200,
    max_sample=100000,
    random_seed=202355,
    labels=None,
    group_names=None,
    times=None,
    time_format=None,
) -> dict:
    projected_emb = np.stack((xs, ys), axis=1)

    x_min, x_max = np.min(xs), np.max(xs)
    y_min, y_max = np.min(ys), np.max(ys)

    x_gap = x_max - x_min
    y_gap = y_max - y_min

    if x_gap > y_gap:
        x_min -= x_gap / 50
        x_max += x_gap / 50
        x_gap = x_max - x_min
        y_min -= (x_gap - y_gap) / 2
        y_max += (x_gap - y_gap) / 2
    else:
        y_min -= y_gap / 50
        y_max += y_gap / 50
        y_gap = y_max - y_min
        x_min -= (y_gap - x_gap) / 2
        x_max += (y_gap - x_gap) / 2

    # Add proportional buffer so KDE density decays to zero before grid edges
    buffer = max(x_max - x_min, y_max - y_min) * 0.15
    x_min -= buffer
    x_max += buffer
    y_min -= buffer
    y_max += buffer

    grid_xs = np.linspace(x_min, x_max, grid_size)
    grid_ys = np.linspace(y_min, y_max, grid_size)
    xx, yy = np.meshgrid(grid_xs, grid_ys)
    grid = np.vstack([xx.ravel(), yy.ravel()]).transpose()

    sample_size = min(max_sample, len(xs))
    n = sample_size
    d = projected_emb.shape[1]
    bw = (n * (d + 2) / 4.0) ** (-1.0 / (d + 4))

    rng = np.random.RandomState(random_seed)
    random_indexes = rng.choice(
        range(projected_emb.shape[0]),
        min(projected_emb.shape[0], sample_size),
        replace=False,
    )

    kde = KernelDensity(kernel="gaussian", bandwidth=bw)
    kde.fit(projected_emb[random_indexes, :])

    log_density = kde.score_samples(grid)
    log_density = np.exp(log_density)
    grid_density = np.reshape(log_density, xx.shape)

    x_min, x_max, y_min, y_max = float(x_min), float(x_max), float(y_min), float(y_max)

    grid_density_json = {
        "grid": grid_density.astype(float).round(4).tolist(),
        "xRange": [x_min, x_max],
        "yRange": [y_min, y_max],
        "padded": True,
        "sampleSize": sample_size,
        "totalPointSize": len(xs),
    }

    if labels is not None and group_names is not None:
        if len(set(labels)) != len(group_names):
            raise IndexError("Number of unique labels must match group_names length.")
        if len(labels) != len(xs):
            raise IndexError("Number of labels must match number of points.")

        grid_density_json["groupGrids"] = {}
        grid_density_json["groupTotalPointSizes"] = {}
        grid_density_json["groupNames"] = group_names

        for cur_label, name in enumerate(group_names):
            cur_xs = [xs[i] for i, label in enumerate(labels) if label == cur_label]
            cur_ys = [ys[i] for i, label in enumerate(labels) if label == cur_label]
            cur_projected_emb = np.stack((cur_xs, cur_ys), axis=1)

            grid_xs = np.linspace(x_min, x_max, grid_size)
            grid_ys = np.linspace(y_min, y_max, grid_size)
            xx, yy = np.meshgrid(grid_xs, grid_ys)
            grid = np.vstack([xx.ravel(), yy.ravel()]).transpose()

            sample_size = min(max_sample, len(cur_xs))
            n = sample_size
            d = cur_projected_emb.shape[1]
            bw = (n * (d + 2) / 4.0) ** (-1.0 / (d + 4))

            rng = np.random.RandomState(random_seed)
            random_indexes = rng.choice(
                range(cur_projected_emb.shape[0]),
                min(cur_projected_emb.shape[0], sample_size),
                replace=False,
            )

            kde = KernelDensity(kernel="gaussian", bandwidth=bw)
            kde.fit(cur_projected_emb[random_indexes, :])

            log_density = kde.score_samples(grid)
            log_density = np.exp(log_density)
            grid_density = np.reshape(log_density, xx.shape)

            grid_density_json["groupGrids"][name] = grid_density.astype(float).round(4).tolist()
            grid_density_json["groupTotalPointSizes"][name] = cur_projected_emb.shape[0]

    return grid_density_json


def top_n_idx_sparse(matrix: csr_matrix, n: int) -> np.ndarray:
    indices = []
    for le, ri in zip(matrix.indptr[:-1], matrix.indptr[1:]):
        n_row_pick = min(n, ri - le)
        values = matrix.indices[
            le + np.argpartition(matrix.data[le:ri], -n_row_pick)[-n_row_pick:]
        ]
        values = [
            values[index] if len(values) >= index + 1 else None for index in range(n)
        ]
        indices.append(values)
    return np.array(indices)


def top_n_values_sparse(matrix: csr_matrix, indices: np.ndarray) -> np.ndarray:
    top_values = []
    for row in range(indices.shape[0]):
        scores = np.array(
            [matrix[row, c] if c is not None else 0 for c in indices[row, :]]
        )
        top_values.append(scores)
    return np.array(top_values)


def merge_leaves_before_level(root: Node, target_level: int) -> Tuple[list, list, dict]:
    x0, y0, x1, y1 = root.position
    step_size = (x1 - x0) / (2**target_level)

    row_pos_map = {}
    stack = [root]
    csr_row_indexes, csr_column_indexes = [], []
    cur_r = 0

    while len(stack) > 0:
        cur_node = stack.pop()

        if cur_node.level >= target_level:
            local_stack = [cur_node]
            subtree_data = []

            while len(local_stack) > 0:
                local_node = local_stack.pop()
                if len(local_node.children) == 0:
                    subtree_data.extend(local_node.data)
                else:
                    for c in local_node.children[::-1]:
                        if c is not None:
                            local_stack.append(c)

            cur_node.children = []
            cur_node.data = subtree_data

            row_pos_map[cur_r] = list(map(lambda x: round(x, 3), cur_node.position))

            for d in cur_node.data:
                csr_row_indexes.append(cur_r)
                csr_column_indexes.append(d["pid"])

            cur_r += 1
        else:
            if len(cur_node.children) == 0:
                x, y = cur_node.data[0]["x"], cur_node.data[0]["y"]
                xi, yi = int((x - x0) // step_size), int((y - y0) // step_size)
                xi0, yi0 = x0 + xi * step_size, y0 + yi * step_size
                xi1, yi1 = xi0 + step_size, yi0 + step_size
                row_pos_map[cur_r] = list(map(lambda x: round(x, 3), [xi0, yi0, xi1, yi1]))

                for d in cur_node.data:
                    csr_row_indexes.append(cur_r)
                    csr_column_indexes.append(d["pid"])

                cur_r += 1
            else:
                for c in cur_node.children[::-1]:
                    if c is not None:
                        stack.append(c)

    return csr_row_indexes, csr_column_indexes, row_pos_map


def get_tile_topics(count_mat, row_pos_map, ngrams, top_k=50):
    t_tf_idf_model = TfidfTransformer()
    t_tf_idf = t_tf_idf_model.fit_transform(count_mat)

    indices = top_n_idx_sparse(t_tf_idf, top_k)
    scores = top_n_values_sparse(t_tf_idf, indices)

    sorted_indices = np.argsort(scores, 1)
    indices = np.take_along_axis(indices, sorted_indices, axis=1)
    scores = np.take_along_axis(scores, sorted_indices, axis=1)

    tile_topics = []
    for r in row_pos_map:
        word_scores = [
            (ngrams[word_index], round(score, 4))
            if word_index is not None and score > 0
            else ("", 0.00001)
            for word_index, score in zip(indices[r][::-1], scores[r][::-1])
        ]
        tile_topics.append({"w": word_scores, "p": row_pos_map[r]})

    return tile_topics


def extract_level_topics(root, count_mat, texts, ngrams, min_level=None, max_level=None):
    level_tile_topics = {}

    if min_level is None:
        min_level = 0
    if max_level is None:
        max_level = root.height

    for level in range(max_level, min_level - 1, -1):
        csr_row_indexes, csr_column_indexes, row_node_map = merge_leaves_before_level(root, level)

        csr_data = [1 for _ in range(len(csr_row_indexes))]
        tile_mat = csr_matrix(
            (csr_data, (csr_row_indexes, csr_column_indexes)),
            shape=(len(texts), len(texts)),
        )

        new_count_mat = tile_mat @ count_mat
        tile_topics = get_tile_topics(new_count_mat, row_node_map, ngrams)
        level_tile_topics[level] = tile_topics

    return level_tile_topics


def select_topic_levels(
    max_zoom_scale, svg_width, svg_height, x_domain, y_domain, tree_extent, ideal_tile_width=35,
):
    svg_length = max(svg_width, svg_height)
    world_length = max(x_domain[1] - x_domain[0], y_domain[1] - y_domain[0])
    tree_to_world_scale = (tree_extent[1][0] - tree_extent[0][0]) / world_length

    scale = 1
    selected_levels = []

    while scale <= max_zoom_scale:
        best_level = 1
        best_tile_width_diff = np.inf

        for l in range(1, 21):
            tile_num = 2**l
            svg_scaled_length = scale * svg_length * tree_to_world_scale
            tile_width = svg_scaled_length / tile_num

            if abs(tile_width - ideal_tile_width) < best_tile_width_diff:
                best_tile_width_diff = abs(tile_width - ideal_tile_width)
                best_level = l

        selected_levels.append(best_level)
        scale += 0.5

    return np.min(selected_levels), np.max(selected_levels)


def generate_topic_dict(
    xs, ys, texts,
    max_zoom_scale=1000, svg_width=1000, svg_height=1000, ideal_tile_width=35,
):
    data = []
    for i, x in enumerate(xs):
        data.append({"x": x, "y": ys[i], "pid": i})

    tree = Quadtree()
    tree.add_all_data(data)

    root = tree.get_node_representation()

    cv = CountVectorizer(stop_words="english", ngram_range=(1, 1))
    count_mat = cv.fit_transform(texts)
    ngrams = cv.get_feature_names_out()

    xs_list = [d["x"] for d in data]
    ys_list = [d["y"] for d in data]
    x_domain = [np.min(xs_list) - 1000, np.max(xs_list) + 1000]
    y_domain = [np.min(ys_list) - 1000, np.max(ys_list) + 1000]

    min_level, max_level = select_topic_levels(
        max_zoom_scale, svg_width, svg_height, x_domain, y_domain,
        tree.extent(), ideal_tile_width,
    )

    level_tile_topics = extract_level_topics(
        root, count_mat, texts, ngrams, min_level=min_level, max_level=max_level,
    )

    data_dict = {
        "extent": tree.extent(),
        "data": {},
        "range": [
            float(x_domain[0]), float(y_domain[0]),
            float(x_domain[1]), float(y_domain[1]),
        ],
    }

    for cur_level in range(min_level, max_level + 1):
        cur_topics = level_tile_topics[cur_level]
        data_dict["data"][cur_level] = []

        for topic in cur_topics:
            name = "-".join([p[0] for p in topic["w"][:4]])
            x = (topic["p"][0] + topic["p"][2]) / 2
            y = (topic["p"][1] + topic["p"][3]) / 2
            data_dict["data"][cur_level].append([round(x, 3), round(y, 3), name])

    return data_dict


def generate_grid_dict(
    xs, ys, texts,
    embedding_name="My Embedding",
    grid_size=200,
    max_sample=100000,
    random_seed=202355,
    max_zoom_scale=1000,
    svg_width=1000,
    svg_height=1000,
    ideal_tile_width=35,
    labels=None,
    group_names=None,
    times=None,
    time_format=None,
    image_label=None,
    image_url_prefix=None,
    opacity=None,
):
    print("Generating contours...")
    contour_dict = generate_contour_dict(
        xs, ys,
        grid_size=grid_size,
        max_sample=max_sample,
        random_seed=random_seed,
        labels=labels,
        group_names=group_names,
        times=times,
        time_format=time_format,
    )

    print("Generating multi-level topic summaries...")
    topic_dict = generate_topic_dict(
        xs, ys, texts,
        max_zoom_scale=max_zoom_scale,
        svg_width=svg_width,
        svg_height=svg_height,
        ideal_tile_width=ideal_tile_width,
    )

    grid_dict = contour_dict
    grid_dict["topic"] = topic_dict
    grid_dict["embeddingName"] = embedding_name

    if opacity is not None:
        grid_dict["opacity"] = opacity

    if image_label is not None:
        image_config = {"imageGroup": image_label}
        if image_url_prefix is not None:
            image_config["imageURLPrefix"] = image_url_prefix
        grid_dict["image"] = image_config

    return grid_dict


def generate_data_list(
    xs, ys, texts,
    embeddings=None, times=None, labels=None,
    citations=None, scholarURLs=None, resSummaries=None,
    googleScholarURLs=None, googleScholarKeywords=None,
    affiliations=None, homePageURLs=None,
) -> list[list]:
    data_list = []
    for i, x in enumerate(xs):
        cur_row = [x, ys[i], texts[i]]

        if times is not None:
            cur_row.append(times[i])
            if labels is not None:
                cur_row.append(labels[i])
        else:
            if labels is not None:
                cur_row.append("")
                cur_row.append(labels[i])

        if citations is not None:
            cur_row.append(citations[i])
        if scholarURLs is not None:
            if scholarURLs[i] != scholarURLs[i]:  # NaN check
                cur_row.append(json.dumps(["https://scholar.google.com/citations/images/avatar_scholar_256.png"]))
            else:
                cur_row.append(json.dumps([scholarURLs[i]]))
        if resSummaries is not None:
            cur_row.append(resSummaries[i])
        if googleScholarURLs is not None:
            cur_row.append(googleScholarURLs[i])
        if googleScholarKeywords is not None:
            cur_row.append(googleScholarKeywords[i])
        if affiliations is not None:
            cur_row.append(affiliations[i])
        if homePageURLs is not None:
            cur_row.append(homePageURLs[i])
        if embeddings is not None:
            cur_row.append(embeddings[i])

        data_list.append(cur_row)
    return data_list


def save_json_files(
    data_list, grid_dict,
    output_dir="./", data_json_name="data.ndjson", grid_json_name="grid.json",
):
    import ndjson as ndjson_lib

    with open(join(output_dir, data_json_name), "w", encoding="utf8") as fp:
        ndjson_lib.dump(data_list, fp)

    with open(join(output_dir, grid_json_name), "w", encoding="utf8") as fp:
        json.dump(grid_dict, fp)
