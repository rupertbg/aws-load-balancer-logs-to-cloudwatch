# AWS Load Balancer S3 Logs to CloudWatch Logs
Stream AWS Load Balancer Logs that are delivered to S3 into CloudWatch Logs for use with features like CloudWatch Logs Insights.

# Usage
Use `cfn/test-pipeline.yml` to deploy an ELB, ALB and NLB to test the Lambda.

To use with your own Load Balancers, deploy `cfn/lambda.yml` and enter the parameters required, such as Load Balancer Name and Type.

# Credits
Based on https://github.com/amazon-archives/cloudwatch-logs-centralize-logs