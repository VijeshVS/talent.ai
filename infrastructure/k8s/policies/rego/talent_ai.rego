package main

import rego.v1

# ---------------------------------------------------------------------------
# Input normalisation.
#
# Conftest has two evaluation modes:
#   --combine   input is an array of {contents: <document>, path: <file>}
#   default     input is a single document object, evaluated once per document
#
# Cross-document rules (namespace/quota presence, environment detection) need
# --combine. The workload rules work in either mode. Both shapes are handled.
# ---------------------------------------------------------------------------

documents contains doc if {
	is_array(input)
	some entry in input
	is_object(entry)
	doc := object.get(entry, "contents", entry)
	is_object(doc)
}

documents contains input if {
	not is_array(input)
}

# ---------------------------------------------------------------------------
# Workload classification
# ---------------------------------------------------------------------------

is_app_deployment(doc) if {
	doc.kind == "Deployment"
	doc.metadata.labels["app.kubernetes.io/part-of"] == "talent-ai"
	doc.metadata.labels["app.kubernetes.io/component"] == "backend"
}

is_app_deployment(doc) if {
	doc.kind == "Deployment"
	doc.metadata.labels["app.kubernetes.io/part-of"] == "talent-ai"
	doc.metadata.labels["app.kubernetes.io/component"] == "edge"
}

is_observability_deployment(doc) if {
	doc.kind == "Deployment"
	name := doc.metadata.labels["app.kubernetes.io/name"]
	name == "prometheus"
}

is_observability_deployment(doc) if {
	doc.kind == "Deployment"
	name := doc.metadata.labels["app.kubernetes.io/name"]
	name == "grafana"
}

# ---------------------------------------------------------------------------
# The nine application workloads: probes, resources, restricted profile.
# ---------------------------------------------------------------------------

deny contains msg if {
	some doc in documents
	is_app_deployment(doc)
	some container in doc.spec.template.spec.containers
	not container.readinessProbe
	msg := sprintf("%s/%s: container %s has no readinessProbe", [doc.kind, doc.metadata.name, container.name])
}

deny contains msg if {
	some doc in documents
	is_app_deployment(doc)
	some container in doc.spec.template.spec.containers
	not container.livenessProbe
	msg := sprintf("%s/%s: container %s has no livenessProbe", [doc.kind, doc.metadata.name, container.name])
}

deny contains msg if {
	some doc in documents
	is_app_deployment(doc)
	some container in doc.spec.template.spec.containers
	resources := object.get(container, "resources", {})
	requests := object.get(resources, "requests", {})
	not object.get(requests, "cpu", "")
	msg := sprintf("%s/%s: container %s has no CPU request", [doc.kind, doc.metadata.name, container.name])
}

deny contains msg if {
	some doc in documents
	is_app_deployment(doc)
	some container in doc.spec.template.spec.containers
	resources := object.get(container, "resources", {})
	requests := object.get(resources, "requests", {})
	not object.get(requests, "memory", "")
	msg := sprintf("%s/%s: container %s has no memory request", [doc.kind, doc.metadata.name, container.name])
}

deny contains msg if {
	some doc in documents
	is_app_deployment(doc)
	some container in doc.spec.template.spec.containers
	resources := object.get(container, "resources", {})
	limits := object.get(resources, "limits", {})
	not object.get(limits, "cpu", "")
	msg := sprintf("%s/%s: container %s has no CPU limit", [doc.kind, doc.metadata.name, container.name])
}

deny contains msg if {
	some doc in documents
	is_app_deployment(doc)
	some container in doc.spec.template.spec.containers
	resources := object.get(container, "resources", {})
	limits := object.get(resources, "limits", {})
	not object.get(limits, "memory", "")
	msg := sprintf("%s/%s: container %s has no memory limit", [doc.kind, doc.metadata.name, container.name])
}

deny contains msg if {
	some doc in documents
	is_app_deployment(doc)
	pod_security := object.get(doc.spec.template.spec, "securityContext", {})
	object.get(pod_security, "runAsNonRoot", false) != true
	msg := sprintf("%s/%s: pod securityContext.runAsNonRoot must be true", [doc.kind, doc.metadata.name])
}

deny contains msg if {
	some doc in documents
	is_app_deployment(doc)
	pod_security := object.get(doc.spec.template.spec, "securityContext", {})
	seccomp := object.get(pod_security, "seccompProfile", {})
	object.get(seccomp, "type", "") != "RuntimeDefault"
	msg := sprintf("%s/%s: seccompProfile.type must be RuntimeDefault", [doc.kind, doc.metadata.name])
}

deny contains msg if {
	some doc in documents
	is_app_deployment(doc)
	some container in doc.spec.template.spec.containers
	security := object.get(container, "securityContext", {})
	object.get(security, "allowPrivilegeEscalation", true) != false
	msg := sprintf("%s/%s: container %s must set allowPrivilegeEscalation=false", [doc.kind, doc.metadata.name, container.name])
}

deny contains msg if {
	some doc in documents
	is_app_deployment(doc)
	some container in doc.spec.template.spec.containers
	security := object.get(container, "securityContext", {})
	capabilities := object.get(security, "capabilities", {})
	drop := object.get(capabilities, "drop", [])
	not "ALL" in drop
	msg := sprintf("%s/%s: container %s must drop ALL capabilities", [doc.kind, doc.metadata.name, container.name])
}

deny contains msg if {
	some doc in documents
	is_app_deployment(doc)
	some container in doc.spec.template.spec.containers
	security := object.get(container, "securityContext", {})
	object.get(security, "readOnlyRootFilesystem", false) != true
	msg := sprintf("%s/%s: container %s must set readOnlyRootFilesystem=true", [doc.kind, doc.metadata.name, container.name])
}

deny contains msg if {
	some doc in documents
	is_app_deployment(doc)
	some container in doc.spec.template.spec.containers
	security := object.get(container, "securityContext", {})
	object.get(security, "privileged", false) == true
	msg := sprintf("%s/%s: container %s must not be privileged", [doc.kind, doc.metadata.name, container.name])
}

# ---------------------------------------------------------------------------
# Observability: baseline only. Root and an absent securityContext are
# permitted and expected. Privileged containers are not.
# ---------------------------------------------------------------------------

deny contains msg if {
	some doc in documents
	is_observability_deployment(doc)
	some container in doc.spec.template.spec.containers
	security := object.get(container, "securityContext", {})
	object.get(security, "privileged", false) == true
	msg := sprintf("%s/%s: container %s must not be privileged", [doc.kind, doc.metadata.name, container.name])
}

# ---------------------------------------------------------------------------
# No host namespaces, for every Deployment in scope.
# ---------------------------------------------------------------------------

deny contains msg if {
	some doc in documents
	doc.kind == "Deployment"
	pod_spec := doc.spec.template.spec
	object.get(pod_spec, "hostNetwork", false) == true
	msg := sprintf("%s/%s: hostNetwork is not allowed", [doc.kind, doc.metadata.name])
}

deny contains msg if {
	some doc in documents
	doc.kind == "Deployment"
	pod_spec := doc.spec.template.spec
	object.get(pod_spec, "hostPID", false) == true
	msg := sprintf("%s/%s: hostPID is not allowed", [doc.kind, doc.metadata.name])
}

deny contains msg if {
	some doc in documents
	doc.kind == "Deployment"
	pod_spec := doc.spec.template.spec
	object.get(pod_spec, "hostIPC", false) == true
	msg := sprintf("%s/%s: hostIPC is not allowed", [doc.kind, doc.metadata.name])
}

# ---------------------------------------------------------------------------
# Namespaces and Pod Security Admission labels
# ---------------------------------------------------------------------------

expected_namespaces := {"talent-ai", "talent-ai-platform", "talent-ai-data"}

namespace_exists(name) if {
	some doc in documents
	doc.kind == "Namespace"
	doc.metadata.name == name
}

deny contains msg if {
	some namespace in expected_namespaces
	not namespace_exists(namespace)
	msg := sprintf("missing Namespace %s", [namespace])
}

psa_enforce_expected := {"talent-ai": "baseline", "talent-ai-platform": "restricted", "talent-ai-data": "baseline"}

deny contains msg if {
	some doc in documents
	doc.kind == "Namespace"
	expected := psa_enforce_expected[doc.metadata.name]
	labels := object.get(doc.metadata, "labels", {})
	object.get(labels, "pod-security.kubernetes.io/enforce", "") != expected
	msg := sprintf("Namespace/%s: pod-security.kubernetes.io/enforce must be %s", [doc.metadata.name, expected])
}

deny contains msg if {
	some doc in documents
	doc.kind == "Namespace"
	expected := psa_enforce_expected[doc.metadata.name]
	labels := object.get(doc.metadata, "labels", {})
	object.get(labels, "pod-security.kubernetes.io/audit", "") != "restricted"
	msg := sprintf("Namespace/%s: pod-security.kubernetes.io/audit must be restricted", [doc.metadata.name])
}

deny contains msg if {
	some doc in documents
	doc.kind == "Namespace"
	expected := psa_enforce_expected[doc.metadata.name]
	labels := object.get(doc.metadata, "labels", {})
	object.get(labels, "pod-security.kubernetes.io/warn", "") != "restricted"
	msg := sprintf("Namespace/%s: pod-security.kubernetes.io/warn must be restricted", [doc.metadata.name])
}

# ---------------------------------------------------------------------------
# Quota and LimitRange presence
# ---------------------------------------------------------------------------

resource_in_talent_ai(kind) if {
	some doc in documents
	doc.kind == kind
	doc.metadata.namespace == "talent-ai"
}

deny contains msg if {
	not resource_in_talent_ai("ResourceQuota")
	msg := "missing ResourceQuota in namespace talent-ai"
}

deny contains msg if {
	not resource_in_talent_ai("LimitRange")
	msg := "missing LimitRange in namespace talent-ai"
}

# ---------------------------------------------------------------------------
# Image pinning: staging and production only.
# ---------------------------------------------------------------------------

default environment := "dev"

environment := env if {
	some doc in documents
	doc.kind == "Namespace"
	doc.metadata.name == "talent-ai"
	env := object.get(doc.metadata.labels, "talent.ai/environment", "dev")
}

deny contains msg if {
	environment != "dev"
	some doc in documents
	doc.kind == "Deployment"
	some container in doc.spec.template.spec.containers
	not regex.match("@sha256:[a-f0-9]{64}$", container.image)
	msg := sprintf("%s/%s: image %s is not digest-pinned", [doc.kind, doc.metadata.name, container.image])
}

deny contains msg if {
	environment != "dev"
	some doc in documents
	doc.kind == "Deployment"
	some container in doc.spec.template.spec.containers
	endswith(container.image, ":latest")
	msg := sprintf("%s/%s: image %s uses :latest", [doc.kind, doc.metadata.name, container.image])
}

# ---------------------------------------------------------------------------
# NetworkPolicy: no ipBlock at all, therefore no 0.0.0.0/0.
# ---------------------------------------------------------------------------

deny contains msg if {
	some doc in documents
	doc.kind == "NetworkPolicy"
	some rule in object.get(doc.spec, "egress", [])
	some peer in object.get(rule, "to", [])
	peer.ipBlock
	msg := sprintf("NetworkPolicy/%s: ipBlock egress is not allowed", [doc.metadata.name])
}

deny contains msg if {
	some doc in documents
	doc.kind == "NetworkPolicy"
	some rule in object.get(doc.spec, "ingress", [])
	some peer in object.get(rule, "from", [])
	peer.ipBlock
	msg := sprintf("NetworkPolicy/%s: ipBlock ingress is not allowed", [doc.metadata.name])
}

# ---------------------------------------------------------------------------
# RBAC: no cluster-admin binding.
# ---------------------------------------------------------------------------

deny contains msg if {
	some doc in documents
	doc.kind == "ClusterRoleBinding"
	doc.roleRef.name == "cluster-admin"
	msg := sprintf("ClusterRoleBinding/%s: cluster-admin is not allowed", [doc.metadata.name])
}

# ---------------------------------------------------------------------------
# OTEL: 'true' must never coexist with the Phase 12 placeholder endpoint.
# ---------------------------------------------------------------------------

deny contains msg if {
	some doc in documents
	doc.kind == "ConfigMap"
	doc.metadata.name == "talent-ai-config"
	object.get(doc.data, "OTEL_ENABLED", "false") == "true"
	regex.match("jaeger-collector\\.talent-ai\\.svc\\.cluster\\.local", object.get(doc.data, "OTEL_EXPORTER_OTLP_ENDPOINT", ""))
	msg := "ConfigMap/talent-ai-config: OTEL_ENABLED is true while the endpoint is the Phase 12 placeholder"
}
