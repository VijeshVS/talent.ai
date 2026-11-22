{{/*
Common labels for the talent.ai workload layer.
*/}}
{{- define "talent-ai.labels" -}}
app.kubernetes.io/part-of: talent-ai
{{- end -}}

{{/*
Merge a per-service override map on top of a defaults map.
The service override wins; defaults fill missing keys.
Usage: include "talent-ai.merge" (list $override $defaults) | fromYaml
*/}}
{{- define "talent-ai.merge" -}}
{{- $override := index . 0 | default (dict) -}}
{{- $defaults := index . 1 | default (dict) -}}
{{- toYaml (merge (deepCopy $override) (deepCopy $defaults)) -}}
{{- end -}}
