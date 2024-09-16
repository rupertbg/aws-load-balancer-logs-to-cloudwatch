module.exports = {
  fields: {
    classic: {
      access: [
        "time",
        "elb",
        "client:port",
        "backend:port",
        "request_processing_time",
        "backend_processing_time",
        "response_processing_time",
        "elb_status_code",
        "backend_status_code",
        "received_bytes",
        "sent_bytes",
        "request",
        "user_agent",
        "ssl_cipher",
        "ssl_protocol",
      ],
    },
    network: {
      access: [
        "type",
        "version",
        "time",
        "elb",
        "listener",
        "client:port",
        "destination:port",
        "connection_time",
        "tls_handshake_time",
        "received_bytes",
        "sent_bytes",
        "incoming_tls_alert",
        "chosen_cert_arn",
        "chosen_cert_serial",
        "tls_cipher",
        "tls_protocol_version",
        "tls_named_group",
        "domain_name",
        "alpn_fe_protocol",
        "alpn_be_protocol",
        "alpn_client_preference_list",
      ],
    },
    application: {
      access: [
        "type",
        "time",
        "elb",
        "client:port",
        "target:port",
        "request_processing_time",
        "target_processing_time",
        "response_processing_time",
        "elb_status_code",
        "target_status_code",
        "received_bytes",
        "sent_bytes",
        "request",
        "user_agent",
        "ssl_cipher",
        "ssl_protocol",
        "target_group_arn",
        "trace_id",
        "domain_name",
        "chosen_cert_arn",
        "matched_rule_priority",
        "request_creation_time",
        "actions_executed",
        "redirect_url",
        "error_reason",
        "target:port_list",
        "target_status_code_list",
        "classification",
        "classification_reason",
      ],
      connection: [
        "timestamp",
        "client_ip",
        "client_port",
        "listener_port",
        "tls_protocol",
        "tls_cipher",
        "tls_handshake_latency",
        "leaf_client_cert_subject",
        "leaf_client_cert_validity",
        "leaf_client_cert_serial_number",
        "tls_verify_status",
      ],
    },
  },
  fieldFunctions: {
    application: {
      "client:port": (element, parsed) => {
        const lastColonIndex = element.lastIndexOf(":");
        const client_ip = element.slice(0, lastColonIndex);
        const client_port = element.slice(lastColonIndex + 1);
        parsed.client_ip = client_ip;
        parsed.client_port = client_port;
      },
      "target:port": (element, parsed) => {
        const lastColonIndex = element.lastIndexOf(":");
        const target_ip = element.slice(0, lastColonIndex);
        const target_port = element.slice(lastColonIndex + 1);
        parsed.target_ip = target_ip;
        parsed.target_port = target_port;
      },
      request: (element, parsed) => {
        const [request_method, request_uri, request_http_version] =
          element.split(/\s+/);
        if (["-", "?"].includes(request_uri[request_uri.length - 1]))
          request_uri = request_uri.slice(0, -1);
        parsed.request_method = request_method;
        parsed.request_uri = request_uri;
        parsed.request_http_version = request_http_version;
        const parsedUrl = new URL(request_uri);
        parsed.request_uri_scheme = parsedUrl.protocol;
        parsed.request_uri_host = parsedUrl.hostname;
        if (parsedUrl.port) parsed.request_uri_port = parseInt(parsedUrl.port);
        parsed.request_uri_path = parsedUrl.pathname;
        parsed.request_uri_query = parsedUrl.query;
      },
    },
  },
};
