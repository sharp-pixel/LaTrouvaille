import pytest

from query_understanding.config import TrainingConfig
from query_understanding.dataset import read_examples
from query_understanding.policy import CompilerPolicy, PolicyViolation, validate_agentic_request_body
from query_understanding.schemas import Constraint


def _example(config: TrainingConfig, policy: CompilerPolicy):
    return read_examples(config.data.train_file, policy)[0]


def test_valid_fixture_passes_policy(config: TrainingConfig, policy: CompilerPolicy) -> None:
    example = _example(config, policy)
    validate_agentic_request_body(
        example.input,
        example.target_body.to_opensearch(),
        policy,
        example.expectations,
    )


def test_policy_rejects_oversized_request(config: TrainingConfig, policy: CompilerPolicy) -> None:
    example = _example(config, policy)
    payload = example.target_body.to_opensearch()
    payload["size"] = policy.max_size + 1
    with pytest.raises(PolicyViolation, match=r"body\.size"):
        validate_agentic_request_body(example.input, payload, policy, example.expectations)


def test_policy_requires_exact_result_size(config: TrainingConfig, policy: CompilerPolicy) -> None:
    example = _example(config, policy)
    payload = example.target_body.to_opensearch()
    payload["size"] = example.expectations.result_size - 1
    with pytest.raises(PolicyViolation, match=r"expectations\.result_size"):
        validate_agentic_request_body(example.input, payload, policy, example.expectations)


def test_policy_total_hits_comparison_is_type_strict(config: TrainingConfig, policy: CompilerPolicy) -> None:
    example = _example(config, policy)
    payload = example.target_body.to_opensearch()
    payload["track_total_hits"] = 1
    expectations = example.expectations.model_copy(update={"track_total_hits": True})
    with pytest.raises(PolicyViolation, match=r"expectations\.track_total_hits"):
        validate_agentic_request_body(example.input, payload, policy, expectations)


def test_policy_rejects_scripts(config: TrainingConfig, policy: CompilerPolicy) -> None:
    example = _example(config, policy)
    payload = example.target_body.to_opensearch()
    payload["query"] = {
        "script_score": {
            "query": {"match": {"title": "dress watch"}},
            "script": {"source": "_score * 100"},
        }
    }
    with pytest.raises(PolicyViolation, match="forbidden DSL key"):
        validate_agentic_request_body(example.input, payload, policy, example.expectations)


def test_policy_rejects_invented_fields(config: TrainingConfig, policy: CompilerPolicy) -> None:
    example = _example(config, policy)
    payload = example.target_body.to_opensearch()
    payload["query"] = {"term": {"private_margin": "high"}}
    with pytest.raises(PolicyViolation, match="private_margin"):
        validate_agentic_request_body(example.input, payload, policy, example.expectations)


def test_policy_rejects_service_owned_source(config: TrainingConfig, policy: CompilerPolicy) -> None:
    example = _example(config, policy)
    payload = {**example.target_body.to_opensearch(), "_source": ["item_id"]}
    with pytest.raises(PolicyViolation, match="unsupported top-level search key"):
        validate_agentic_request_body(example.input, payload, policy, example.expectations)


def test_policy_rejects_unknown_query_type(config: TrainingConfig, policy: CompilerPolicy) -> None:
    example = _example(config, policy)
    payload = example.target_body.to_opensearch()
    payload["query"] = {"function_score": {"query": {"match_all": {}}}}
    with pytest.raises(PolicyViolation, match="unsupported query type"):
        validate_agentic_request_body(example.input, payload, policy, example.expectations)


def test_required_filter_must_be_in_positive_bool_filter(
    config: TrainingConfig,
    policy: CompilerPolicy,
) -> None:
    example = _example(config, policy)
    payload = example.target_body.to_opensearch()
    query = payload["query"]
    assert isinstance(query, dict)
    bool_query = query["bool"]
    assert isinstance(bool_query, dict)
    filters = bool_query["filter"]
    assert isinstance(filters, list)
    availability = filters.pop(0)
    bool_query["must_not"] = [availability]
    with pytest.raises(PolicyViolation, match="required filter is missing: availability term"):
        validate_agentic_request_body(example.input, payload, policy, example.expectations)


def test_nested_must_not_cannot_satisfy_required_filter(
    config: TrainingConfig,
    policy: CompilerPolicy,
) -> None:
    example = _example(config, policy)
    payload = example.target_body.to_opensearch()
    query = payload["query"]
    assert isinstance(query, dict)
    bool_query = query["bool"]
    assert isinstance(bool_query, dict)
    filters = bool_query["filter"]
    assert isinstance(filters, list)
    availability = filters.pop(0)
    filters.insert(0, {"bool": {"must_not": [availability]}})
    with pytest.raises(PolicyViolation, match="required filter is missing: availability term"):
        validate_agentic_request_body(example.input, payload, policy, example.expectations)


def test_required_field_must_have_one_direct_filter_clause(
    config: TrainingConfig,
    policy: CompilerPolicy,
) -> None:
    example = _example(config, policy)
    payload = example.target_body.to_opensearch()
    query = payload["query"]
    assert isinstance(query, dict)
    bool_query = query["bool"]
    assert isinstance(bool_query, dict)
    filters = bool_query["filter"]
    assert isinstance(filters, list)
    filters.append({"term": {"availability": "inactive"}})
    with pytest.raises(PolicyViolation, match=r"availability.*exactly one direct"):
        validate_agentic_request_body(example.input, payload, policy, example.expectations)


def test_required_field_is_forbidden_in_must_not(
    config: TrainingConfig,
    policy: CompilerPolicy,
) -> None:
    example = _example(config, policy)
    payload = example.target_body.to_opensearch()
    query = payload["query"]
    assert isinstance(query, dict)
    bool_query = query["bool"]
    assert isinstance(bool_query, dict)
    bool_query["must_not"] = [{"term": {"category": "watches"}}]
    with pytest.raises(PolicyViolation, match=r"category.*only allowed as a direct"):
        validate_agentic_request_body(example.input, payload, policy, example.expectations)


def test_required_terms_filter_uses_exact_set_semantics(
    config: TrainingConfig,
    policy: CompilerPolicy,
) -> None:
    example = _example(config, policy)
    payload = example.target_body.to_opensearch()
    query = payload["query"]
    assert isinstance(query, dict)
    bool_query = query["bool"]
    assert isinstance(bool_query, dict)
    filters = bool_query["filter"]
    assert isinstance(filters, list)
    category_index = next(
        index
        for index, clause in enumerate(filters)
        if isinstance(clause, dict) and isinstance(clause.get("term"), dict) and "category" in clause["term"]
    )
    filters[category_index] = {"terms": {"category": ["dresses", "watches"]}}
    required_terms = Constraint(field="category", op="terms", value=["watches", "dresses"])
    expectations = example.expectations.model_copy(
        update={
            "required_filters": [
                required_terms,
                *(constraint for constraint in example.expectations.required_filters if constraint.field != "category"),
            ]
        }
    )

    validate_agentic_request_body(example.input, payload, policy, expectations)

    filters[category_index] = {"terms": {"category": ["dresses", "watches", "bags"]}}
    with pytest.raises(PolicyViolation, match="required filter is missing: category terms"):
        validate_agentic_request_body(example.input, payload, policy, expectations)


def test_anded_single_terms_do_not_satisfy_required_or_filter(
    config: TrainingConfig,
    policy: CompilerPolicy,
) -> None:
    example = _example(config, policy)
    payload = example.target_body.to_opensearch()
    query = payload["query"]
    assert isinstance(query, dict)
    bool_query = query["bool"]
    assert isinstance(bool_query, dict)
    filters = bool_query["filter"]
    assert isinstance(filters, list)
    filters[:] = [
        clause
        for clause in filters
        if not (isinstance(clause, dict) and isinstance(clause.get("term"), dict) and "category" in clause["term"])
    ]
    filters.extend([{"term": {"category": "watches"}}, {"term": {"category": "dresses"}}])
    required_terms = Constraint(field="category", op="terms", value=["watches", "dresses"])
    expectations = example.expectations.model_copy(
        update={
            "required_filters": [
                required_terms,
                *(constraint for constraint in example.expectations.required_filters if constraint.field != "category"),
            ]
        }
    )

    with pytest.raises(PolicyViolation, match="required filter is missing: category terms"):
        validate_agentic_request_body(example.input, payload, policy, expectations)


def test_terms_lookup_payload_is_forbidden(config: TrainingConfig, policy: CompilerPolicy) -> None:
    example = _example(config, policy)
    payload = example.target_body.to_opensearch()
    query = payload["query"]
    assert isinstance(query, dict)
    bool_query = query["bool"]
    assert isinstance(bool_query, dict)
    filters = bool_query["filter"]
    assert isinstance(filters, list)
    filters.append(
        {
            "terms": {
                "category": {
                    "index": "private_lookup",
                    "id": "all-categories",
                    "path": "values",
                }
            }
        }
    )
    with pytest.raises(PolicyViolation, match="terms lookup is forbidden"):
        validate_agentic_request_body(example.input, payload, policy, example.expectations)


def test_nonblank_query_requires_positive_text_relevance(
    config: TrainingConfig,
    policy: CompilerPolicy,
) -> None:
    example = _example(config, policy)
    payload = example.target_body.to_opensearch()
    query = payload["query"]
    assert isinstance(query, dict)
    bool_query = query["bool"]
    assert isinstance(bool_query, dict)
    bool_query.pop("must", None)
    with pytest.raises(PolicyViolation, match="required positive text relevance clause"):
        validate_agentic_request_body(example.input, payload, policy, example.expectations)


def test_optional_should_does_not_satisfy_text_relevance_requirement(
    config: TrainingConfig,
    policy: CompilerPolicy,
) -> None:
    example = _example(config, policy)
    payload = example.target_body.to_opensearch()
    query = payload["query"]
    assert isinstance(query, dict)
    bool_query = query["bool"]
    assert isinstance(bool_query, dict)
    must = bool_query.pop("must")
    assert isinstance(must, list)
    bool_query["should"] = must
    with pytest.raises(PolicyViolation, match="required positive text relevance clause"):
        validate_agentic_request_body(example.input, payload, policy, example.expectations)


def test_required_should_does_not_replace_canonical_must_text_clause(
    config: TrainingConfig,
    policy: CompilerPolicy,
) -> None:
    example = _example(config, policy)
    payload = example.target_body.to_opensearch()
    query = payload["query"]
    assert isinstance(query, dict)
    bool_query = query["bool"]
    assert isinstance(bool_query, dict)
    must = bool_query.pop("must")
    assert isinstance(must, list)
    bool_query["should"] = must
    bool_query["minimum_should_match"] = 1
    with pytest.raises(PolicyViolation, match="required positive text relevance clause"):
        validate_agentic_request_body(example.input, payload, policy, example.expectations)


def test_text_query_in_filter_does_not_replace_required_must_clause(
    config: TrainingConfig,
    policy: CompilerPolicy,
) -> None:
    example = _example(config, policy)
    payload = example.target_body.to_opensearch()
    query = payload["query"]
    assert isinstance(query, dict)
    bool_query = query["bool"]
    assert isinstance(bool_query, dict)
    must = bool_query.pop("must")
    filters = bool_query["filter"]
    assert isinstance(must, list)
    assert isinstance(filters, list)
    filters.extend(must)
    with pytest.raises(PolicyViolation, match="required positive text relevance clause"):
        validate_agentic_request_body(example.input, payload, policy, example.expectations)


def test_numeric_field_does_not_satisfy_text_relevance_requirement(
    config: TrainingConfig,
    policy: CompilerPolicy,
) -> None:
    example = _example(config, policy)
    payload = example.target_body.to_opensearch()
    query = payload["query"]
    assert isinstance(query, dict)
    bool_query = query["bool"]
    assert isinstance(bool_query, dict)
    bool_query["must"] = [{"multi_match": {"query": "formal watch", "fields": ["price"]}}]
    with pytest.raises(PolicyViolation, match="required positive text relevance clause"):
        validate_agentic_request_body(example.input, payload, policy, example.expectations)


def test_empty_query_does_not_satisfy_text_relevance_requirement(
    config: TrainingConfig,
    policy: CompilerPolicy,
) -> None:
    example = _example(config, policy)
    payload = example.target_body.to_opensearch()
    query = payload["query"]
    assert isinstance(query, dict)
    bool_query = query["bool"]
    assert isinstance(bool_query, dict)
    bool_query["must"] = [{"multi_match": {"query": "   ", "fields": ["title"]}}]
    with pytest.raises(PolicyViolation, match="required positive text relevance clause"):
        validate_agentic_request_body(example.input, payload, policy, example.expectations)


def test_optional_numeric_match_is_rejected(config: TrainingConfig, policy: CompilerPolicy) -> None:
    example = _example(config, policy)
    payload = example.target_body.to_opensearch()
    query = payload["query"]
    assert isinstance(query, dict)
    bool_query = query["bool"]
    assert isinstance(bool_query, dict)
    bool_query.setdefault("should", []).append({"match": {"old_price": "500"}})
    with pytest.raises(PolicyViolation, match="requires a mapped text field: old_price"):
        validate_agentic_request_body(example.input, payload, policy, example.expectations)


def test_prefix_requires_keyword_field(config: TrainingConfig, policy: CompilerPolicy) -> None:
    example = _example(config, policy)
    payload = example.target_body.to_opensearch()
    query = payload["query"]
    assert isinstance(query, dict)
    bool_query = query["bool"]
    assert isinstance(bool_query, dict)
    bool_query.setdefault("should", []).append({"prefix": {"price": "50"}})
    with pytest.raises(PolicyViolation, match="prefix requires a compatible mapped field: price"):
        validate_agentic_request_body(example.input, payload, policy, example.expectations)


def test_rank_feature_requires_rank_feature_field(config: TrainingConfig, policy: CompilerPolicy) -> None:
    example = _example(config, policy)
    payload = example.target_body.to_opensearch()
    query = payload["query"]
    assert isinstance(query, dict)
    bool_query = query["bool"]
    assert isinstance(bool_query, dict)
    bool_query.setdefault("should", []).append({"rank_feature": {"field": "price"}})
    with pytest.raises(PolicyViolation, match="requires a mapped rank_feature field: price"):
        validate_agentic_request_body(example.input, payload, policy, example.expectations)


def test_unsatisfiable_date_range_is_rejected(config: TrainingConfig, policy: CompilerPolicy) -> None:
    example = _example(config, policy)
    payload = example.target_body.to_opensearch()
    query = payload["query"]
    assert isinstance(query, dict)
    bool_query = query["bool"]
    assert isinstance(bool_query, dict)
    bool_query.setdefault("should", []).append({"range": {"listed_at": {"gte": "2026-01-01", "lte": "2025-01-01"}}})
    with pytest.raises(PolicyViolation, match=r"range\.listed_at is unsatisfiable"):
        validate_agentic_request_body(example.input, payload, policy, example.expectations)


def test_cross_clause_conjunctive_ranges_are_rejected(config: TrainingConfig, policy: CompilerPolicy) -> None:
    example = _example(config, policy)
    payload = example.target_body.to_opensearch()
    query = payload["query"]
    assert isinstance(query, dict)
    bool_query = query["bool"]
    assert isinstance(bool_query, dict)
    filters = bool_query["filter"]
    assert isinstance(filters, list)
    filters.extend([{"range": {"old_price": {"gte": 600}}}, {"range": {"old_price": {"lte": 500}}}])
    with pytest.raises(PolicyViolation, match="conjunctive old_price ranges are unsatisfiable"):
        validate_agentic_request_body(example.input, payload, policy, example.expectations)


def test_cross_clause_exact_constraints_are_rejected(config: TrainingConfig, policy: CompilerPolicy) -> None:
    example = _example(config, policy)
    payload = example.target_body.to_opensearch()
    query = payload["query"]
    assert isinstance(query, dict)
    bool_query = query["bool"]
    assert isinstance(bool_query, dict)
    filters = bool_query["filter"]
    must = bool_query["must"]
    assert isinstance(filters, list)
    assert isinstance(must, list)
    filters.append({"term": {"shipping": "free"}})
    must.append({"terms": {"shipping": ["paid", "pickup"]}})
    with pytest.raises(PolicyViolation, match="conjunctive shipping exact constraints are unsatisfiable"):
        validate_agentic_request_body(example.input, payload, policy, example.expectations)


def test_cross_clause_exact_and_range_constraints_are_rejected(
    config: TrainingConfig,
    policy: CompilerPolicy,
) -> None:
    example = _example(config, policy)
    payload = example.target_body.to_opensearch()
    query = payload["query"]
    assert isinstance(query, dict)
    bool_query = query["bool"]
    assert isinstance(bool_query, dict)
    filters = bool_query["filter"]
    must = bool_query["must"]
    assert isinstance(filters, list)
    assert isinstance(must, list)
    filters.append({"term": {"old_price": 600}})
    must.append({"range": {"old_price": {"lt": 600}}})
    with pytest.raises(PolicyViolation, match="conjunctive old_price exact/range constraints are unsatisfiable"):
        validate_agentic_request_body(example.input, payload, policy, example.expectations)


def test_normalized_keyword_exact_constraints_can_overlap(config: TrainingConfig, policy: CompilerPolicy) -> None:
    example = _example(config, policy)
    payload = example.target_body.to_opensearch()
    query = payload["query"]
    assert isinstance(query, dict)
    bool_query = query["bool"]
    assert isinstance(bool_query, dict)
    filters = bool_query["filter"]
    must = bool_query["must"]
    assert isinstance(filters, list)
    assert isinstance(must, list)
    filters.append({"term": {"shipping": "Free"}})
    must.append({"term": {"shipping": "free"}})
    validate_agentic_request_body(example.input, payload, policy, example.expectations)


def test_exact_queries_require_compatible_mapping_and_shape(config: TrainingConfig, policy: CompilerPolicy) -> None:
    example = _example(config, policy)

    text_exact = example.target_body.to_opensearch()
    text_query = text_exact["query"]
    assert isinstance(text_query, dict)
    text_bool = text_query["bool"]
    assert isinstance(text_bool, dict)
    text_bool.setdefault("filter", []).append({"term": {"title": "canvas"}})
    with pytest.raises(PolicyViolation, match="term requires a mapped exact-value field: title"):
        validate_agentic_request_body(example.input, text_exact, policy, example.expectations)

    multifield = example.target_body.to_opensearch()
    multifield_query = multifield["query"]
    assert isinstance(multifield_query, dict)
    multifield_bool = multifield_query["bool"]
    assert isinstance(multifield_bool, dict)
    multifield_bool.setdefault("filter", []).append({"term": {"color": "red", "shipping": "free"}})
    with pytest.raises(PolicyViolation, match="term must name exactly one field"):
        validate_agentic_request_body(example.input, multifield, policy, example.expectations)

    excessive_terms = example.target_body.to_opensearch()
    excessive_query = excessive_terms["query"]
    assert isinstance(excessive_query, dict)
    excessive_bool = excessive_query["bool"]
    assert isinstance(excessive_bool, dict)
    excessive_bool.setdefault("filter", []).append({"terms": {"color": [f"color-{index}" for index in range(101)]}})
    with pytest.raises(PolicyViolation, match="terms must contain between 1 and 100 values"):
        validate_agentic_request_body(example.input, excessive_terms, policy, example.expectations)

    fractional_integer = example.target_body.to_opensearch()
    fractional_query = fractional_integer["query"]
    assert isinstance(fractional_query, dict)
    fractional_bool = fractional_query["bool"]
    assert isinstance(fractional_bool, dict)
    fractional_bool.setdefault("filter", []).append({"term": {"old_price": 1.5}})
    with pytest.raises(PolicyViolation, match=r"term\.old_price contains a value incompatible with its mapped type"):
        validate_agentic_request_body(example.input, fractional_integer, policy, example.expectations)


def test_integer_ranges_use_a_discrete_domain(config: TrainingConfig, policy: CompilerPolicy) -> None:
    example = _example(config, policy)

    empty_interval = example.target_body.to_opensearch()
    empty_query = empty_interval["query"]
    assert isinstance(empty_query, dict)
    empty_bool = empty_query["bool"]
    assert isinstance(empty_bool, dict)
    empty_bool.setdefault("should", []).append({"range": {"old_price": {"gt": 1, "lt": 2}}})
    with pytest.raises(PolicyViolation, match=r"range\.old_price is unsatisfiable"):
        validate_agentic_request_body(example.input, empty_interval, policy, example.expectations)

    singleton = example.target_body.to_opensearch()
    singleton_query = singleton["query"]
    assert isinstance(singleton_query, dict)
    singleton_bool = singleton_query["bool"]
    assert isinstance(singleton_bool, dict)
    singleton_bool.setdefault("should", []).append({"range": {"old_price": {"gte": 2, "lte": 2}}})
    validate_agentic_request_body(example.input, singleton, policy, example.expectations)

    for impossible_bound in ({"gt": 2_147_483_647}, {"lt": -2_147_483_648}):
        outside_mapping = example.target_body.to_opensearch()
        outside_query = outside_mapping["query"]
        assert isinstance(outside_query, dict)
        outside_bool = outside_query["bool"]
        assert isinstance(outside_bool, dict)
        outside_bool.setdefault("should", []).append({"range": {"old_price": impossible_bound}})
        with pytest.raises(PolicyViolation, match=r"range\.old_price is unsatisfiable"):
            validate_agentic_request_body(example.input, outside_mapping, policy, example.expectations)

    for inclusive_bound in ({"gte": -2_147_483_648}, {"lte": 2_147_483_647}):
        mapping_edge = example.target_body.to_opensearch()
        edge_query = mapping_edge["query"]
        assert isinstance(edge_query, dict)
        edge_bool = edge_query["bool"]
        assert isinstance(edge_bool, dict)
        edge_bool.setdefault("should", []).append({"range": {"old_price": inclusive_bound}})
        validate_agentic_request_body(example.input, mapping_edge, policy, example.expectations)


def test_mixed_epoch_and_iso_date_ranges_use_epoch_milliseconds(
    config: TrainingConfig,
    policy: CompilerPolicy,
) -> None:
    example = _example(config, policy)
    payload = example.target_body.to_opensearch()
    query = payload["query"]
    assert isinstance(query, dict)
    bool_query = query["bool"]
    assert isinstance(bool_query, dict)
    filters = bool_query["filter"]
    must = bool_query["must"]
    assert isinstance(filters, list)
    assert isinstance(must, list)
    filters.append({"range": {"listed_at": {"gte": 1_735_689_600_000}}})
    must.append({"range": {"listed_at": {"lt": "2025-01-01"}}})
    with pytest.raises(PolicyViolation, match="conjunctive listed_at ranges are unsatisfiable"):
        validate_agentic_request_body(example.input, payload, policy, example.expectations)


def test_must_not_is_not_supported_by_native_objective(
    config: TrainingConfig,
    policy: CompilerPolicy,
) -> None:
    example = _example(config, policy)
    payload = example.target_body.to_opensearch()
    query = payload["query"]
    assert isinstance(query, dict)
    bool_query = query["bool"]
    assert isinstance(bool_query, dict)
    bool_query["must_not"] = [{"match": {"title": "formal watch"}}]
    with pytest.raises(PolicyViolation, match=r"unsupported bool key.*must_not"):
        validate_agentic_request_body(example.input, payload, policy, example.expectations)


def test_minimum_should_match_cannot_exceed_should_count(
    config: TrainingConfig,
    policy: CompilerPolicy,
) -> None:
    example = _example(config, policy)
    payload = example.target_body.to_opensearch()
    query = payload["query"]
    assert isinstance(query, dict)
    bool_query = query["bool"]
    assert isinstance(bool_query, dict)
    should = bool_query.get("should", [])
    assert isinstance(should, list)
    bool_query["minimum_should_match"] = len(should) + 1
    with pytest.raises(PolicyViolation, match="minimum_should_match must be an integer between 0"):
        validate_agentic_request_body(example.input, payload, policy, example.expectations)


def test_policy_rejects_wrong_sort_direction(config: TrainingConfig, policy: CompilerPolicy) -> None:
    example = next(
        candidate
        for candidate in read_examples(config.data.train_file, policy)
        if candidate.expectations.sort_mode == "lowest_price"
    )
    payload = example.target_body.to_opensearch()
    payload["sort"] = [{"price": {"order": "desc"}}, {"_score": {"order": "desc"}}]
    with pytest.raises(PolicyViolation, match="price asc"):
        validate_agentic_request_body(example.input, payload, policy, example.expectations)


def test_policy_rejects_extra_sort_clause(config: TrainingConfig, policy: CompilerPolicy) -> None:
    example = next(
        candidate
        for candidate in read_examples(config.data.train_file, policy)
        if candidate.expectations.sort_mode == "lowest_price"
    )
    payload = example.target_body.to_opensearch()
    sort = payload["sort"]
    assert isinstance(sort, list)
    sort.append({"listed_at": {"order": "desc"}})
    with pytest.raises(PolicyViolation, match="exactly two clauses"):
        validate_agentic_request_body(example.input, payload, policy, example.expectations)


def test_policy_validates_every_sort_clause(config: TrainingConfig, policy: CompilerPolicy) -> None:
    example = next(
        candidate
        for candidate in read_examples(config.data.train_file, policy)
        if candidate.expectations.sort_mode == "lowest_price"
    )
    payload = example.target_body.to_opensearch()
    sort = payload["sort"]
    assert isinstance(sort, list)
    sort[1] = {"_score": {"order": "desc", "mode": "avg"}}
    with pytest.raises(PolicyViolation, match="unsupported options: mode"):
        validate_agentic_request_body(example.input, payload, policy, example.expectations)
