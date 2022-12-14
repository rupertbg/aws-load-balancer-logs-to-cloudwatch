variable "ecr_repo_tags" {
  description = "A map of tags to assign to ECR repository"
  type        = map(string)
  default     = {}
}

variable "lambda_tags" {
  description = "A map of tags to assign to Lambda function"
  type        = map(string)
  default     = {}
}

variable "ecr_repo_name" {
  description = "Name of ECR repository for Lambda image"
  type        = string
  default     = "aws-load-balancer-logs-to-cloudwatch"
}

variable "scan_on_push" {
  description = "Indicates whether images are scanned after being pushed to the repository"
  type        = bool
  default     = false
}

variable "log_group_name" {
  description = "A CloudWatch log group name to load data into it"
  type        = string
}

variable "load_balancer_type" {
  description = "value"

  validation {
    condition     = length(regexall("^(classic|application|network)$", var.type)) > 0
    error_message = "ERROR: Valid types are `classic`, `application` or `network`"
  }
}

variable "s3_bucket" {
  description = "S3 bucket to listen for objects"
  type        = string

}

variable "s3_filter_prefix" {
  description = "Prefix of S3 Object to ingest"
  type        = string
  default     = "AWSLogs/"
}

variable "s3_filter_suffix" {
  description = "Suffix of S3 Object to ingest"
  type        = string
  default     = ".log"
}
