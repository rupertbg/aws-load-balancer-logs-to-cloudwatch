module "docker_image" {
  source = "terraform-aws-modules/lambda/aws//modules/docker-build"

  create_ecr_repo = true
  ecr_repo        = "aws-load-balancer-logs-to-cloudwatch"
  image_tag       = "latest"
  source_path     = "src"
}

module "lambda_function" {
  source = "terraform-aws-modules/lambda/aws"

  image_uri    = module.docker_image.image_uri
  package_type = "Image"

  tags = var.lambda_tags

  environment_variables = {
    LOG_GROUP_NAME     = var.log_group_name
    LOAD_BALANCER_TYPE = var.load_balancer_type
  }
}

resource "aws_s3_bucket_notification" "aws-lambda-trigger" {
  bucket = var.s3_bucket

  lambda_function {
    lambda_function_arn = module.lambda_function.lambda_function_arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = var.s3_filter_prefix
    filter_suffix       = var.s3_filter_suffix
  }
}

resource "aws_lambda_permission" "test" {
  statement_id  = "AllowS3Invoke"
  action        = "lambda:InvokeFunction"
  function_name = module.lambda_function.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = "arn:aws:s3:::${var.s3_bucket}"
}
